import { app, BrowserWindow } from 'electron';
import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type {
  ServerStatus,
  ServerPidFile,
  ServerStatePayload,
  ServerLogEntry,
  ServerDiagnostics,
  ModelDownloadState,
  EngineStatus,
  ServerRuntimeFingerprint,
} from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';
import {
  isOwnedEveServerProcess,
  parseServerPidFile,
  parseHealthyResponse,
  matchesExpectedRuntime,
  type HealthState,
  type ExpectedRuntimeIdentity,
  type ServerProcessSnapshot,
} from './server-health.js';
import {
  START_HEALTH_TIMEOUT_MS,
  START_PID_TIMEOUT_MS,
  waitForPidFile,
} from './server-startup.js';
import { buildChildEnvironment } from './server-environment.js';
import { BoundedLogDeliveryQueue, ServerLogFramer } from './server-log-transport.js';
import type { GpuPackManager, ValidatedGpuRuntime } from './gpu-pack-manager.js';

const log = createLogger('ServerManager');

const MAX_LOG_ENTRIES = 500;
const SERVER_LOG_DELIVERY_INTERVAL_MS = 50;
const SERVER_LOG_DELIVERY_BATCH_SIZE = 50;
const HEALTH_POLL_INTERVAL_MS = 3000;
// Server-side GPU probes may consume their full two-second timeout. Keep
// enough response overhead here while still finishing before the next poll.
const HEALTH_REQUEST_TIMEOUT_MS = 2500;
const STOP_TIMEOUT_MS = 10000;
const execFileAsync = promisify(execFile);

export interface ServerManagerDeps {
  spawn?: typeof spawn;
  isProcessAlive?: (pid: number) => boolean;
  isOwnedServerProcess?: (pid: number, recordedStartedAt: number) => Promise<boolean>;
  getHealthState?: (port: number, timeoutMs?: number) => Promise<HealthState>;
  getServerCommand?: (gpuRuntime: ValidatedGpuRuntime | null) => {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  } | null;
  waitForPidFile?: (
    readFn: () => ServerPidFile | null,
    timeoutMs: number,
    spawnStartedAt?: number,
  ) => Promise<ServerPidFile | null>;
  waitForHealth?: (port: number, timeoutMs: number) => Promise<HealthState | null>;
  waitForProcessExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
  readPidFile?: (requireCurrentApp?: boolean) => ServerPidFile | null;
  appVersion?: string;
  isPackaged?: boolean;
}

export class ServerManager {
  constructor(
    private readonly gpuPackManager?: GpuPackManager,
    private readonly deps?: ServerManagerDeps,
  ) {}

  private status: ServerStatus = 'idle';
  private currentError: string | null = null;
  private activeRuntimeLease: RuntimeLease | null = null;
  private activeRuntimeConsumers: { pids: number[]; identified: boolean } = { pids: [], identified: false };
  private retainedRuntimeLeases = new Map<RuntimeLease, { pids: number[]; identified: boolean }>();
  private processGeneration = 0;
  private startInFlight: Promise<void> | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private lastLifecycleRequest: { kind: 'start' | 'stop' | 'restart' | 'cleanup'; promise: Promise<void> } | null = null;
  private cleaningUp = false;
  private childProcess: ChildProcess | null = null;
  private pidFile: ServerPidFile | null = null;
  private logs: ServerLogEntry[] = [];
  private readonly pendingLogDelivery = new BoundedLogDeliveryQueue<ServerLogEntry>(MAX_LOG_ENTRIES);
  private logDeliveryTimer: ReturnType<typeof setTimeout> | null = null;
  private healthPollInterval: ReturnType<typeof setInterval> | null = null;
  private healthPollGeneration = 0;
  private mainWindow: BrowserWindow | null = null;
  private managed = false; // Whether we spawned the server (production) vs detected it (dev)
  private startedAt: number | null = null;
  private serverVersion: string | null = null;
  private diagnostics: ServerDiagnostics | null = null;
  private modelDownload: ModelDownloadState | null = null;
  private engineStatus: EngineStatus | null = null;
  private runtime: ServerRuntimeFingerprint | null = null;
  private runningRuntimeIdentity: ExpectedRuntimeIdentity | null = null;

  private async expectedRuntime(): Promise<{
    identity: ExpectedRuntimeIdentity;
    gpuRuntime: ValidatedGpuRuntime | null;
  }> {
    const gpuRuntime = await this.gpuPackManager?.getValidatedRuntime() ?? null;
    const build = this.deps?.appVersion ?? app.getVersion();
    return {
      identity: { app_build: build, server_build: build, pack_id: gpuRuntime?.packId ?? null },
      gpuRuntime,
    };
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Get Electron's PID path, supplied verbatim to Python via MURMUR_PID_FILE.
   */
  private getPidFilePath(): string {
    return path.join(app.getPath('userData'), 'server.pid');
  }

  /**
   * Read and parse the PID file.
   */
  private readPidFile(strict = true): ServerPidFile | null {
    if (this.deps?.readPidFile) return this.deps.readPidFile(strict);
    const pidPath = this.getPidFilePath();
    try {
      const content = fs.readFileSync(pidPath, 'utf-8');
      return parseServerPidFile(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      log.warn('Failed to read PID file', { error: error as Error });
      if (strict) {
        throw new Error('Server PID state is invalid or inaccessible');
      }
      return null;
    }
  }

  /**
   * Check if a process is alive by attempting to send signal 0.
   */
  private isProcessAlive(pid: number): boolean {
    if (this.deps?.isProcessAlive) return this.deps.isProcessAlive(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async replaceRuntimeLease(next: RuntimeLease | null, pids: number[], identified: boolean): Promise<void> {
    const previous = this.activeRuntimeLease;
    if (previous && previous !== next) this.retainedRuntimeLeases.set(previous, this.activeRuntimeConsumers);
    this.activeRuntimeLease = next;
    this.activeRuntimeConsumers = { pids, identified };
    for (const [lease, consumers] of this.retainedRuntimeLeases) {
      if (consumers.identified && consumers.pids.length > 0 && consumers.pids.every((pid) => !this.isProcessAlive(pid))) {
        try {
          await lease.release();
          this.retainedRuntimeLeases.delete(lease);
        } catch (error) { log.warn('Failed to release prior runtime lease', { error }); }
      }
    }
  }

  /**
   * Check server health by hitting the /health endpoint.
   */
  private async getHealthState(
    port: number,
    timeoutMs = HEALTH_REQUEST_TIMEOUT_MS,
  ): Promise<HealthState> {
    if (this.deps?.getHealthState) return this.deps.getHealthState(port, timeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://localhost:${port}/health`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        return { healthy: false };
      }

      return parseHealthyResponse(await response.json());
    } catch {
      return { healthy: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Start health polling for a running server.
   */
  private startHealthPolling(port: number): void {
    this.stopHealthPolling();
    const generation = this.healthPollGeneration;
    const serverPid = this.pidFile?.pid;
    const childPid = this.childProcess?.pid;
    const lease = this.activeRuntimeLease;
    this.healthPollInterval = setInterval(async () => {
      const health = await this.getHealthState(port);
      if (generation !== this.healthPollGeneration) return;
      if (serverPid && !this.isProcessAlive(serverPid) && (!childPid || !this.isProcessAlive(childPid))) {
        this.stopHealthPolling();
        this.childProcess = null;
        this.pidFile = null;
        this.setRuntime(undefined);
        this.setEngineStatus(undefined);
        this.setModelDownload(undefined);
        this.setDiagnostics(undefined);
        this.updateStatus('error', 'Server process exited unexpectedly');
        if (lease && this.activeRuntimeLease === lease) {
          this.activeRuntimeLease = null;
          try { await lease.release(); } catch (error) { log.warn('Failed to release terminated runtime lease', { error }); }
        }
        await this.replaceRuntimeLease(null, [], false);
        return;
      }
      if (!health.healthy) {
        if (this.status === 'running') {
          log.warn('Server health check failed');
          this.setDiagnostics(undefined);
          this.setModelDownload(undefined);
          this.setEngineStatus(undefined);
          this.setRuntime(undefined);
          this.updateStatus('error', 'Health check failed');
        }
        return;
      }

      if (
        (this.deps?.isPackaged ?? app.isPackaged)
        && this.runningRuntimeIdentity
        && !matchesExpectedRuntime(health.runtime, this.runningRuntimeIdentity)
      ) {
        log.warn('Server runtime identity changed during health polling');
        this.updateStatus('error', 'Server runtime identity changed');
        return;
      }

      const recovered = this.status === 'error';
      if (recovered) {
        this.status = 'running';
        this.currentError = null;
      }
      const diagnosticsChanged = this.setDiagnostics(health.diagnostics);
      const downloadChanged = this.setModelDownload(health.modelDownload);
      const engineChanged = this.setEngineStatus(health.engineStatus);
      const runtimeChanged = this.setRuntime(health.runtime);
      let shouldBroadcast = recovered || diagnosticsChanged || downloadChanged || engineChanged || runtimeChanged;

      if (health.version && health.version !== this.serverVersion) {
        this.serverVersion = health.version;
        shouldBroadcast = true;
      }

      if (shouldBroadcast) {
        this.broadcastState();
      }
    }, HEALTH_POLL_INTERVAL_MS);
  }

  private setDiagnostics(next?: ServerDiagnostics): boolean {
    const nextValue = next ?? null;
    const currentSerialized = JSON.stringify(this.diagnostics);
    const nextSerialized = JSON.stringify(nextValue);
    if (currentSerialized === nextSerialized) {
      return false;
    }
    this.diagnostics = nextValue;
    return true;
  }

  private setRuntime(next?: ServerRuntimeFingerprint): boolean {
    const value = next ?? null;
    if (JSON.stringify(this.runtime) === JSON.stringify(value)) return false;
    this.runtime = value;
    return true;
  }

  private setModelDownload(next?: ModelDownloadState): boolean {
    const nextValue = next ?? null;
    const currentSerialized = JSON.stringify(this.modelDownload);
    const nextSerialized = JSON.stringify(nextValue);
    if (currentSerialized === nextSerialized) {
      return false;
    }
    this.modelDownload = nextValue;
    return true;
  }

  private async isOwnedServerProcess(pid: number, recordedStartedAt: number): Promise<boolean> {
    if (this.childProcess?.pid === pid) return true;
    if (this.deps?.isOwnedServerProcess) return this.deps.isOwnedServerProcess(pid, recordedStartedAt);
    if (process.platform !== 'win32') return false;

    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { [pscustomobject]@{ ProcessId = $p.ProcessId; CreationTimeMs = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds(); ExecutablePath = $p.ExecutablePath; CommandLine = $p.CommandLine } | ConvertTo-Json -Compress }`,
        ],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      );
      const snapshot = JSON.parse(stdout.trim()) as {
        ProcessId?: unknown;
        CreationTimeMs?: unknown;
        ExecutablePath?: unknown;
        CommandLine?: unknown;
      };
      if (
        typeof snapshot.ProcessId !== 'number'
        || typeof snapshot.CreationTimeMs !== 'number'
        || typeof snapshot.ExecutablePath !== 'string'
        || typeof snapshot.CommandLine !== 'string'
      ) {
        return false;
      }
      return isOwnedEveServerProcess(
        {
          processId: snapshot.ProcessId,
          creationTimeMs: snapshot.CreationTimeMs,
          executablePath: snapshot.ExecutablePath,
          commandLine: snapshot.CommandLine,
        } satisfies ServerProcessSnapshot,
        pid,
        recordedStartedAt
      );
    } catch (error) {
      log.warn('Could not verify stale server process ownership', {
        pid,
        error: error as Error,
      });
      return false;
    }
  }

  private setEngineStatus(next?: EngineStatus): boolean {
    const nextValue = next ?? null;
    if (JSON.stringify(this.engineStatus) === JSON.stringify(nextValue)) {
      return false;
    }
    this.engineStatus = nextValue;
    return true;
  }

  /**
   * Stop health polling.
   */
  private stopHealthPolling(): void {
    this.healthPollGeneration += 1;
    if (this.healthPollInterval) {
      clearInterval(this.healthPollInterval);
      this.healthPollInterval = null;
    }
  }

  /**
   * Add a log entry and broadcast to renderer.
   */
  private addLog(level: 'stdout' | 'stderr', message: string): void {
    const entry: ServerLogEntry = {
      timestamp: Date.now(),
      level,
      message: message.trimEnd(),
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.shift();
    }
    this.broadcastLog(entry);
  }

  private clearPendingLogDelivery(): void {
    if (this.logDeliveryTimer !== null) {
      clearTimeout(this.logDeliveryTimer);
      this.logDeliveryTimer = null;
    }
    this.pendingLogDelivery.clear();
  }

  private scheduleLogDelivery(): void {
    if (this.logDeliveryTimer !== null) return;

    this.logDeliveryTimer = setTimeout(() => {
      this.logDeliveryTimer = null;
      this.flushLogDelivery();
    }, SERVER_LOG_DELIVERY_INTERVAL_MS);
  }

  private flushLogDelivery(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.pendingLogDelivery.clear();
      return;
    }

    for (const entry of this.pendingLogDelivery.drain(SERVER_LOG_DELIVERY_BATCH_SIZE)) {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        this.pendingLogDelivery.clear();
        return;
      }
      this.mainWindow.webContents.send(IPC_CHANNELS.SERVER_LOG, entry);
    }

    if (this.pendingLogDelivery.size > 0) {
      this.scheduleLogDelivery();
    }
  }

  /**
   * Update status and broadcast to renderer.
   */
  private updateStatus(status: ServerStatus, error?: string): void {
    this.status = status;
    this.currentError = status === 'error' ? (error ?? null) : null;
    this.broadcastState(error);
  }

  /**
   * Broadcast current state to renderer.
   */
  private broadcastState(error?: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const payload = this.getState(error);
    this.mainWindow.webContents.send(IPC_CHANNELS.SERVER_STATE_CHANGE, payload);
  }

  /**
   * Broadcast a log entry to renderer.
   */
  private broadcastLog(entry: ServerLogEntry): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.pendingLogDelivery.enqueue(entry);
    this.scheduleLogDelivery();
  }

  /**
   * Get current server state payload.
   */
  getState(errorOverride?: string): ServerStatePayload {
    const uptime =
      this.status === 'running' && this.startedAt
        ? Date.now() - this.startedAt
        : undefined;

    return {
      status: this.status,
      pid: this.pidFile?.pid,
      port: this.pidFile?.port,
      version: this.serverVersion ?? undefined,
      uptime,
      error: errorOverride ?? (this.currentError ?? undefined),
      wsUrl: this.pidFile?.port
        ? `ws://localhost:${this.pidFile.port}/transcribe`
        : undefined,
      managed: this.managed,
      engineStatus: this.engineStatus ?? undefined,
      diagnostics: this.diagnostics ?? undefined,
      modelDownload: this.modelDownload ?? undefined,
      runtime: this.runtime ?? undefined,
    };
  }

  /**
   * Get buffered logs.
   */
  getLogs(): ServerLogEntry[] {
    return [...this.logs];
  }

  /**
   * Detect an existing server (for dev mode).
   * Returns true if a healthy server was found.
   */
  async detectExisting(): Promise<boolean> {
    log.info('Detecting existing server');

    const pidData = this.readPidFile();
    if (!pidData) {
      log.info('No PID file found');
      this.serverVersion = null;
      this.setDiagnostics(undefined);
      this.setModelDownload(undefined);
      this.setEngineStatus(undefined);
      this.setRuntime(undefined);
      this.updateStatus('stopped');
      return false;
    }

    // Check if process is alive
    if (!this.isProcessAlive(pidData.pid)) {
      log.info('PID file exists but process is dead, cleaning up');
      this.cleanupStalePidFile();
      this.serverVersion = null;
      this.setDiagnostics(undefined);
      this.setModelDownload(undefined);
      this.setEngineStatus(undefined);
      this.setRuntime(undefined);
      this.updateStatus('stopped');
      return false;
    }

    if (!(await this.isOwnedServerProcess(pidData.pid, pidData.startedAt))) {
      log.warn('PID file belongs to an unverified process; refusing adoption', {
        pid: pidData.pid,
      });
      this.updateStatus('error', 'Server process ownership could not be verified');
      return false;
    }

    // Check health only after process ownership is proven.
    const health = await this.getHealthState(pidData.port);
    if (!health.healthy) {
      log.warn('Server process alive but not responding to health checks');
      this.serverVersion = null;
      this.setDiagnostics(undefined);
      this.setModelDownload(undefined);
      this.setEngineStatus(undefined);
      this.setRuntime(undefined);
      this.updateStatus('error', 'Server not responding');
      return false;
    }

    const isPackaged = this.deps?.isPackaged ?? app.isPackaged;
    const expected = isPackaged ? (await this.expectedRuntime()).identity : null;
    if (expected && !matchesExpectedRuntime(health.runtime, expected)) {
      log.warn('Detected server runtime does not match this Eve build');
      this.updateStatus('error', 'Existing server uses a different runtime; start Eve server to replace it');
      return false;
    }

    let adoptedLease: RuntimeLease | null = null;
    if (health.runtime?.pack_id) {
      if (!this.gpuPackManager || typeof this.gpuPackManager.acquireRuntime !== 'function') {
        log.warn('Detected server requires GPU pack but GpuPackManager is unavailable; refusing adoption');
        this.updateStatus('error', 'GPU runtime lease unavailable for existing server');
        return false;
      }
      try {
        adoptedLease = await this.gpuPackManager.acquireRuntime();
      } catch (err) {
        log.warn('Failed to acquire runtime lease for detected server', { error: err });
        this.updateStatus('error', 'GPU runtime lease unavailable for existing server');
        return false;
      }
      if (!adoptedLease) {
        log.warn('Failed to acquire runtime lease for detected server; refusing adoption');
        this.updateStatus('error', 'GPU runtime lease unavailable for existing server');
        return false;
      }
      if (adoptedLease.runtime.packId !== health.runtime.pack_id) {
        log.warn('Acquired lease packId does not match detected server packId; releasing and refusing adoption');
        try { await adoptedLease.release(); } catch {}
        this.updateStatus('error', 'GPU runtime mismatch for existing server');
        return false;
      }
      try {
        await adoptedLease.bindServerPid(pidData.pid);
      } catch (bindErr) {
        log.warn('Failed to bind server PID to acquired lease; retaining protection and refusing adoption', { error: bindErr });
        await this.replaceRuntimeLease(adoptedLease, [pidData.pid], true);
        this.updateStatus('error', 'Failed to bind GPU lease to existing server');
        return false;
      }
    }

    // Found a healthy server
    await this.replaceRuntimeLease(adoptedLease, [pidData.pid], true);
    this.pidFile = pidData;
    this.startedAt = pidData.startedAt;
    this.serverVersion = health.version ?? null;
    this.setDiagnostics(health.diagnostics);
    this.setModelDownload(health.modelDownload);
    this.setEngineStatus(health.engineStatus);
    this.setRuntime(health.runtime);
    this.runningRuntimeIdentity = expected;
    this.managed = false; // The server was detected rather than spawned by Eve.
    this.processGeneration += 1;
    this.updateStatus('running');
    this.startHealthPolling(pidData.port);

    log.info('Detected running server', { pid: pidData.pid, port: pidData.port });
    return true;
  }

  /**
   * Clean up a stale PID file.
   */
  private cleanupStalePidFile(): void {
    const pidPath = this.getPidFilePath();
    try {
      if (fs.existsSync(pidPath)) {
        fs.unlinkSync(pidPath);
        log.info('Removed stale PID file');
      }
    } catch (error) {
      log.warn('Failed to remove stale PID file', { error: error as Error });
    }
  }

  /**
   * Get the command and arguments to spawn the server.
   * Returns null if server path cannot be determined.
   */
  private getServerCommand(gpuRuntime: ValidatedGpuRuntime | null): {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  } | null {
    if (this.deps?.getServerCommand) return this.deps.getServerCommand(gpuRuntime);
    // In production, the server is bundled with the app
    // The exact path depends on how the app is packaged

    // For now, assume the server is in resources/server relative to app path
    const isPackaged = app.isPackaged;

    if (isPackaged) {
      // Production: server is in resources
      const resourcesPath = process.resourcesPath;
      const serverDir = path.join(resourcesPath, 'server');
      const runtimePython = path.join(serverDir, '.runtime', 'python.exe');
      const legacyPython = path.join(serverDir, '.venv', 'Scripts', 'python.exe');
      const sitePackages = path.join(serverDir, '.venv', 'Lib', 'site-packages');
      const mainPy = path.join(serverDir, 'src', 'main.py');

      let pythonExe = runtimePython;
      if (!fs.existsSync(runtimePython)) {
        if (!fs.existsSync(legacyPython)) {
          log.error('Server Python runtime not found', {
            runtimePath: runtimePython,
            legacyPath: legacyPython,
          });
          return null;
        }
        pythonExe = legacyPython;
        log.warn('Using legacy virtual-environment Python; packaged builds should include .runtime', {
          path: legacyPython,
        });
      } else if (!fs.existsSync(sitePackages)) {
        log.error('Bundled server site-packages not found', { path: sitePackages });
        return null;
      }

      const systemPath = Object.entries(process.env).find(
        ([key]) => key.toLowerCase() === 'path',
      )?.[1];
      const bundledRuntimePath = gpuRuntime
        ? [gpuRuntime.directory, systemPath].filter(Boolean).join(path.delimiter)
        : systemPath;

      return {
        command: pythonExe,
        args: [mainPy],
        cwd: serverDir,
        env: {
          PYTHONNOUSERSITE: '1',
          PYTHONUTF8: '1',
          PYTHONPATH: fs.existsSync(sitePackages)
            ? [sitePackages, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
            : process.env.PYTHONPATH,
          PATH: bundledRuntimePath,
          MURMUR_APP_BUILD_ID: app.getVersion(),
          MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
          MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
        },
      };
    } else {
      // Development mode - this shouldn't be called, but provide fallback
      // In dev, run Python manually with the matching MURMUR_PID_FILE override.
      log.warn('getServerCommand called in development mode');
      return null;
    }
  }

  /**
   * Start the server (production mode only).
   */
  start(): Promise<void> {
    if (this.cleaningUp) return Promise.resolve();
    const attempt = this.enqueueLifecycle('start', async () => {
      if (!this.cleaningUp) await this.startOnce();
    });
    this.startInFlight = attempt;
    const clearStart = () => {
      if (this.startInFlight === attempt) this.startInFlight = null;
    };
    void attempt.then(clearStart, clearStart);
    return attempt;
  }

  private enqueueLifecycle(
    kind: 'start' | 'stop' | 'restart' | 'cleanup',
    action: () => Promise<void>,
  ): Promise<void> {
    if (kind !== 'cleanup' && this.lastLifecycleRequest?.kind === kind) {
      return this.lastLifecycleRequest.promise;
    }
    const attempt = this.lifecycleTail.then(action);
    this.lastLifecycleRequest = { kind, promise: attempt };
    this.lifecycleTail = attempt.then(() => {}, () => {});
    const clearLast = () => {
      if (this.lastLifecycleRequest?.promise === attempt) this.lastLifecycleRequest = null;
    };
    void attempt.then(clearLast, clearLast);
    return attempt;
  }

  private async startOnce(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') {
      log.info('Server already running or starting');
      return;
    }

    const isPackaged = this.deps?.isPackaged ?? app.isPackaged;
    const expectedRuntime = isPackaged ? await this.expectedRuntime() : null;
    if (this.cleaningUp) return;

    // Check for existing server first
    const existingPid = this.readPidFile();
    if (existingPid && this.isProcessAlive(existingPid.pid)) {
      const owned = await this.isOwnedServerProcess(existingPid.pid, existingPid.startedAt);
      if (this.cleaningUp) return;
      if (!owned) {
        log.warn('PID file belongs to an unverified process; refusing replacement', {
          pid: existingPid.pid,
        });
        this.updateStatus('error', 'Server process ownership could not be verified');
        return;
      }

      let adoptedLease: RuntimeLease | null = null;
      let leaseOk = true;
      const health = await this.getHealthState(existingPid.port);
      if (this.cleaningUp) return;
      if (
        health.healthy
        && (!expectedRuntime || matchesExpectedRuntime(health.runtime, expectedRuntime.identity))
      ) {
        if (health.runtime?.pack_id) {
          if (this.gpuPackManager && typeof this.gpuPackManager.acquireRuntime === 'function') {
            try {
              adoptedLease = await this.gpuPackManager.acquireRuntime();
              if (adoptedLease) {
                if (adoptedLease.runtime.packId !== health.runtime.pack_id) {
                  leaseOk = false;
                } else {
                  try {
                    await adoptedLease.bindServerPid(existingPid.pid);
                  } catch {
                    leaseOk = false;
                  }
                }
              } else {
                leaseOk = false;
              }
            } catch {
              leaseOk = false;
            }
          } else {
            leaseOk = false;
          }
        }

        if (leaseOk) {
          log.info('Found existing healthy server, adopting');
          await this.replaceRuntimeLease(adoptedLease, [existingPid.pid], true);
          this.pidFile = existingPid;
          this.startedAt = existingPid.startedAt;
          this.serverVersion = health.version ?? null;
          this.setDiagnostics(health.diagnostics);
          this.setModelDownload(health.modelDownload);
          this.setEngineStatus(health.engineStatus);
          this.setRuntime(health.runtime);
          this.runningRuntimeIdentity = expectedRuntime?.identity ?? null;
          this.managed = false;
          this.processGeneration += 1;
          this.updateStatus('running');
          this.startHealthPolling(existingPid.port);
          return;
        }

        log.warn('Existing server GPU pack could not be leased; terminating it to avoid unleased GPU runtime');
      }

      log.warn('Existing owned Eve server is unhealthy or uses a different runtime; terminating it');
      if (adoptedLease) await this.replaceRuntimeLease(adoptedLease, [existingPid.pid], true);
      try {
        try { process.kill(existingPid.pid, 'SIGTERM'); } catch {}
        const exited = await this.waitForProcessExit(existingPid.pid, 5000);
        if (this.cleaningUp) {
          return;
        }
        if (!exited) {
          try { process.kill(existingPid.pid, 'SIGKILL'); } catch {}
          const forceExited = await this.waitForProcessExit(existingPid.pid, 2000);
          if (!forceExited) {
            this.updateStatus('error', 'Existing server did not stop');
            return;
          }
        }
      } catch {
        this.updateStatus('error', 'Existing server could not be stopped');
        return;
      } finally {
        if (adoptedLease && !this.isProcessAlive(existingPid.pid)) {
          try { await adoptedLease.release(); } catch {}
          if (this.activeRuntimeLease === adoptedLease) this.activeRuntimeLease = null;
        }
      }
      this.cleanupStalePidFile();
    } else if (existingPid) {
      this.cleanupStalePidFile();
    }

    // Cleanup can begin while runtime validation or an existing-server probe awaits.
    // No asynchronous work remains between this check and spawn().
    if (this.cleaningUp) return;

    let processLease: RuntimeLease | null = null;
    let effectiveGpuRuntime: ValidatedGpuRuntime | null = null;
    if (this.gpuPackManager && typeof this.gpuPackManager.acquireRuntime === 'function') {
      try {
        processLease = await this.gpuPackManager.acquireRuntime();
        if (processLease) {
          effectiveGpuRuntime = processLease.runtime;
        } else {
          effectiveGpuRuntime = null;
        }
      } catch (err) {
        log.warn('Failed to acquire GPU runtime lease; falling back to CPU', { error: err });
        processLease = null;
        effectiveGpuRuntime = null;
      }
    }

    if (this.cleaningUp) {
      if (processLease) {
        try { await processLease.release(); } catch {}
      }
      return;
    }

    const serverCmd = this.getServerCommand(effectiveGpuRuntime);
    const effectiveExpectedIdentity: ExpectedRuntimeIdentity | null = isPackaged
      ? { app_build: this.deps?.appVersion ?? app.getVersion(), server_build: this.deps?.appVersion ?? app.getVersion(), pack_id: effectiveGpuRuntime?.packId ?? null }
      : null;
    if (!serverCmd) {
      if (processLease) {
        try { await processLease.release(); } catch {}
      }
      this.updateStatus('error', 'Cannot find server executable');
      return;
    }

    log.info('Starting server', { command: serverCmd.command, cwd: serverCmd.cwd });
    this.updateStatus('starting');
    this.managed = true;
    this.serverVersion = null;
    this.setDiagnostics(undefined);
    this.setModelDownload(undefined);
    this.setEngineStatus(undefined);
    this.setRuntime(undefined);
    this.clearPendingLogDelivery();
    this.logs = []; // Clear logs for new session
    await this.replaceRuntimeLease(processLease, [], false);
    if (this.cleaningUp) {
      if (processLease) await processLease.release();
      if (this.activeRuntimeLease === processLease) this.activeRuntimeLease = null;
      return;
    }

    let childPid: number | undefined;
    let boundServerPid: number | undefined;
    let verifiedServerKnown = false;
    const processGeneration = ++this.processGeneration;
    try {
      const spawnStartedAt = Date.now();
      const childEnv = buildChildEnvironment(process.env, serverCmd.env, {
        MURMUR_PID_FILE: this.getPidFilePath(),
        MURMUR_SETTINGS_FILE: path.join(app.getPath('userData'), 'server-settings.json'),
        MURMUR_HOST: '127.0.0.1',
        MURMUR_PORT: '0',
      });
      if (!effectiveGpuRuntime) {
        // Never inherit a user-supplied DLL path or pack ID into the CPU server.
        delete childEnv.MURMUR_GPU_RUNTIME_DIR;
        delete childEnv.MURMUR_GPU_PACK_ID;
      }
      // Transformers v5 removes this deprecated variable. HF_HOME and the
      // standard Hugging Face cache discovery continue to work normally.
      delete childEnv.TRANSFORMERS_CACHE;

      const spawnFn = this.deps?.spawn ?? spawn;
      this.childProcess = spawnFn(serverCmd.command, serverCmd.args, {
        cwd: serverCmd.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        env: childEnv,
      });

      const stdoutFramer = new ServerLogFramer();
      const stderrFramer = new ServerLogFramer();
      const emitFramedLogs = (framer: ServerLogFramer, level: 'stdout' | 'stderr') => {
        for (const line of framer.flush()) {
          this.addLog(level, line);
        }
      };

      // Capture stdout
      this.childProcess.stdout?.on('data', (data: Buffer) => {
        for (const line of stdoutFramer.push(data)) {
          this.addLog('stdout', line);
        }
      });
      this.childProcess.stdout?.once('end', () => emitFramedLogs(stdoutFramer, 'stdout'));

      // Capture stderr
      this.childProcess.stderr?.on('data', (data: Buffer) => {
        for (const line of stderrFramer.push(data)) {
          this.addLog('stderr', line);
        }
      });
      this.childProcess.stderr?.once('end', () => emitFramedLogs(stderrFramer, 'stderr'));

      this.childProcess.once('close', () => {
        emitFramedLogs(stdoutFramer, 'stdout');
        emitFramedLogs(stderrFramer, 'stderr');
      });

      const child = this.childProcess;
      childPid = child.pid;
      this.activeRuntimeConsumers = { pids: childPid ? [childPid] : [], identified: false };

      let leaseReleased = false;
      let leaseOpQueue: Promise<void> = Promise.resolve();

      const safeBindServerPid = async (pid: number, role: 'wrapper' | 'server' = 'server') => {
        const op = leaseOpQueue.then(async () => {
          if (leaseReleased) {
            throw new Error('Runtime lease already released');
          }
          if (!processLease) return;
          boundServerPid = pid;
          await processLease.bindServerPid(pid, role);
        });
        leaseOpQueue = op.catch(() => {});
        return op;
      };

      const releaseProcessLease = async (force = false) => {
        const op = leaseOpQueue.then(async () => {
          if (leaseReleased || !processLease) return;
          // A launcher can exit before its daemon writes the PID file.
          // Until discovery completes, its exit cannot prove all consumers died.
          if (childPid && !verifiedServerKnown) return;
          if (!force) {
            const isChildAlive = childPid ? this.isProcessAlive(childPid) : false;
            const serverPid = boundServerPid;
            const isServerAlive = serverPid ? this.isProcessAlive(serverPid) : false;
            if (isChildAlive || isServerAlive) {
              log.warn('Refusing to release runtime lease while process is still alive', {
                childPid,
                isChildAlive,
                serverPid,
                isServerAlive,
              });
              return;
            }
          }
          leaseReleased = true;
          if (this.activeRuntimeLease === processLease) {
            this.activeRuntimeLease = null;
          }
          try {
            await processLease.release();
          } catch (leaseErr) {
            log.warn('Failed to release runtime lease on process exit', { error: leaseErr });
          }
        });
        leaseOpQueue = op.catch(() => {});
        return op;
      };

      // Handle process exit - registered before any await so child death is never missed
      child.on('exit', (code, signal) => {
        log.info('Server process exited', { code, signal, childPid });

        if (processGeneration !== this.processGeneration) {
          log.info('Ignoring exit from stale child process', { childPid });
          void releaseProcessLease();
          return;
        }

        const actualServerPid = boundServerPid;
        const isWrapperExit = actualServerPid !== undefined && actualServerPid !== childPid;
        const isServerStillAlive = isWrapperExit && this.isProcessAlive(actualServerPid);

        if (isServerStillAlive) {
          log.info('Wrapper process exited but server process is still alive', { childPid, actualServerPid });
          if (this.childProcess === child) {
            this.childProcess = null;
          }
          return;
        }

        if (this.childProcess === child) {
          this.childProcess = null;
        }
        this.stopHealthPolling();
        this.pidFile = null;
        this.startedAt = null;
        this.serverVersion = null;
        this.setDiagnostics(undefined);
        this.setModelDownload(undefined);
        this.setEngineStatus(undefined);
        this.setRuntime(undefined);

        void releaseProcessLease();

        if (this.status !== 'stopping') {
          if (this.status !== 'error') {
            this.updateStatus('error', 'Server process exited unexpectedly');
          }
        } else {
          this.updateStatus('stopped');
        }
      });

      child.on('error', (error) => {
        log.error('Failed to start server process or child stream error', { error });

        if (processGeneration !== this.processGeneration) {
          log.info('Ignoring error from stale child process', { childPid });
          void releaseProcessLease();
          return;
        }

        const isChildAlive = childPid ? this.isProcessAlive(childPid) : false;
        const serverPid = boundServerPid;
        const isServerAlive = serverPid ? this.isProcessAlive(serverPid) : false;
        const isLiving = isChildAlive || isServerAlive;

        if (isLiving) {
          log.warn('Child process emitted error while process is still alive; retaining refs and lease', {
            childPid,
            serverPid,
          });
          this.updateStatus('error', 'Server process error');
          return;
        }

        if (this.childProcess === child) {
          this.childProcess = null;
        }
        this.stopHealthPolling();
        this.pidFile = null;
        this.startedAt = null;
        this.serverVersion = null;
        this.setDiagnostics(undefined);
        this.setModelDownload(undefined);
        this.setEngineStatus(undefined);
        this.setRuntime(undefined);

        void releaseProcessLease(true);

        this.updateStatus('error', 'Failed to start server');
      });

      if (childPid && processLease) {
        try {
          await safeBindServerPid(childPid, 'wrapper');
        } catch (bindErr) {
          log.error('Failed to bind child process PID to runtime lease; stopping child', { error: bindErr });
          try { child.kill('SIGTERM'); } catch {}
          const confirmedExited = await this.waitForProcessExit(childPid, 5000);
          if (!confirmedExited) {
            try { child.kill('SIGKILL'); } catch {}
            await this.waitForProcessExit(childPid, 2000);
          }
          throw new Error('Failed to bind runtime lease to server PID');
        }
      }

      // Wait for PID file to appear (indicates server is ready)
      const waitPidFileFn = this.deps?.waitForPidFile ?? waitForPidFile;
      const pidData = await waitPidFileFn(
        () => this.readPidFile(false),
        START_PID_TIMEOUT_MS,
        spawnStartedAt,
      );
      if (!pidData) {
        throw new Error('Server did not write PID file within timeout');
      }

      if (!(await this.isOwnedServerProcess(pidData.pid, pidData.startedAt))) {
        throw new Error('Server process ownership could not be verified');
      }
      this.pidFile = pidData;
      boundServerPid = pidData.pid;
      verifiedServerKnown = true;
      this.activeRuntimeConsumers = { pids: [...new Set([childPid, pidData.pid].filter((pid): pid is number => pid !== undefined))], identified: true };

      if (pidData.pid && processLease) {
        try {
          await safeBindServerPid(pidData.pid);
        } catch (bindErr) {
          log.error('Failed to bind PID file PID to runtime lease; stopping child', { error: bindErr });
          try { child.kill('SIGTERM'); } catch {}
          try { process.kill(pidData.pid, 'SIGTERM'); } catch {}
          if (childPid) {
            const confirmedChild = await this.waitForProcessExit(childPid, 5000);
            if (!confirmedChild) {
              try { child.kill('SIGKILL'); } catch {}
              await this.waitForProcessExit(childPid, 2000);
            }
          }
          const confirmedServer = await this.waitForProcessExit(pidData.pid, 5000);
          if (!confirmedServer) {
            try { process.kill(pidData.pid, 'SIGKILL'); } catch {}
            await this.waitForProcessExit(pidData.pid, 2000);
          }
          throw new Error('Failed to bind runtime lease to server PID');
        }
      }

      // Wait for health check to pass
      const health = await this.waitForHealth(pidData.port, START_HEALTH_TIMEOUT_MS);
      if (!health) {
        throw new Error('Server health check did not pass within timeout');
      }
      if (effectiveExpectedIdentity && !matchesExpectedRuntime(health.runtime, effectiveExpectedIdentity)) {
        throw new Error('Server runtime identity did not match this Eve build');
      }

      const isStillAlive = this.isProcessAlive(pidData.pid);
      if (!isStillAlive) {
        throw new Error('Server process exited before startup completed');
      }

      this.pidFile = pidData;
      this.startedAt = pidData.startedAt;
      this.serverVersion = health.version ?? null;
      this.setDiagnostics(health.diagnostics);
      this.setModelDownload(health.modelDownload);
      this.setEngineStatus(health.engineStatus);
      this.setRuntime(health.runtime);
      this.runningRuntimeIdentity = effectiveExpectedIdentity;
      this.updateStatus('running');
      this.startHealthPolling(pidData.port);

      log.info('Server started successfully', { pid: pidData.pid, port: pidData.port });
    } catch (error) {
      log.error('Failed to start server', { error: error as Error });
      const rawMsg = (error as Error)?.message ?? '';
      const safeMsg = rawMsg.includes('PID file')
        ? 'Server did not write PID file within timeout'
        : rawMsg.includes('health check')
        ? 'Server health check did not pass within timeout'
        : rawMsg.includes('ownership')
        ? 'Server process ownership could not be verified'
        : rawMsg.includes('identity')
        ? 'Server runtime identity did not match this Eve build'
        : rawMsg.includes('bind')
        ? 'Failed to bind runtime lease to server process'
        : 'Failed to start server';

      this.updateStatus('error', safeMsg);

      // Kill the process if it's still running
      if (this.childProcess) {
        try { this.childProcess.kill('SIGTERM'); } catch {}
        if (childPid) {
          const exited = await this.waitForProcessExit(childPid, 5000);
          if (!exited) {
            try { this.childProcess.kill('SIGKILL'); } catch {}
            await this.waitForProcessExit(childPid, 2000);
          }
        }
        if (!childPid || !this.isProcessAlive(childPid)) this.childProcess = null;
      }

      const isChildAlive = childPid ? this.isProcessAlive(childPid) : false;
      const serverPid = boundServerPid;
      const isServerAlive = serverPid ? this.isProcessAlive(serverPid) : false;
      if (!isChildAlive && !isServerAlive && (verifiedServerKnown || !childPid) && this.activeRuntimeLease) {
        try {
          await this.activeRuntimeLease.release();
        } catch {}
        this.activeRuntimeLease = null;
      }
    }
  }

  /**
   * Wait for health check to pass.
   */
  private async waitForHealth(port: number, timeoutMs: number): Promise<HealthState | null> {
    if (this.deps?.waitForHealth) return this.deps.waitForHealth(port, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;

      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const health = await Promise.race([
          this.getHealthState(port, Math.min(HEALTH_REQUEST_TIMEOUT_MS, remainingMs)),
          new Promise<null>((resolve) => {
            deadlineTimer = setTimeout(() => resolve(null), remainingMs);
          }),
        ]);
        if (health?.healthy) {
          return health;
        }
      } finally {
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
      }

      const remainingAfterCheckMs = deadline - Date.now();
      if (remainingAfterCheckMs <= 0) return null;

      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(500, remainingAfterCheckMs));
      });
    }
  }

  /**
   * Wait for a process to exit.
   */
  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    if (this.deps?.waitForProcessExit) return this.deps.waitForProcessExit(pid, timeoutMs);
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!this.isProcessAlive(pid)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  /**
   * Stop the server.
   */
  stop(): Promise<void> {
    return this.enqueueLifecycle('stop', () => this.stopOnce());
  }

  private async stopOnce(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'idle' || this.status === 'stopping') {
      return;
    }

    if (!this.managed) {
      log.info('Server is not managed, cannot stop a detected process');
      return;
    }

    log.info('Stopping server');
    this.updateStatus('stopping');
    this.stopHealthPolling();

    // Snapshot references before any await or kill
    const child = this.childProcess;
    const childPid = child?.pid;
    const daemonPid = this.pidFile?.pid;
    const daemonStartedAt = this.pidFile?.startedAt ?? 0;
    const lease = this.activeRuntimeLease;

    let stoppedGracefully = false;

    try {
      // Try graceful shutdown via API first
      if (this.pidFile?.port) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);

          await fetch(`http://localhost:${this.pidFile.port}/shutdown`, {
            method: 'POST',
            signal: controller.signal,
          });
          clearTimeout(timeout);

          // Wait for both processes to exit
          const childExited = childPid ? await this.waitForProcessExit(childPid, STOP_TIMEOUT_MS) : true;
          const daemonExited = daemonPid ? await this.waitForProcessExit(daemonPid, STOP_TIMEOUT_MS) : true;

          if (childExited && daemonExited) {
            stoppedGracefully = true;
          }
        } catch (error) {
          log.warn('Graceful shutdown failed', { error: error as Error });
        }
      }

      if (!stoppedGracefully) {
        // Force kill if graceful shutdown failed
        log.info('Force killing server process');

        if (child) {
          try { child.kill('SIGTERM'); } catch {}
        }
        if (daemonPid && daemonPid !== childPid) {
          if (await this.isOwnedServerProcess(daemonPid, daemonStartedAt)) {
            try { process.kill(daemonPid, 'SIGTERM'); } catch {}
          } else {
            log.warn('Refusing to stop unverified PID', { pid: daemonPid });
          }
        }

        // Wait a bit for SIGTERM
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // If still running, SIGKILL
        if (child && childPid && this.isProcessAlive(childPid)) {
          try { child.kill('SIGKILL'); } catch {}
        }
        if (daemonPid && daemonPid !== childPid && this.isProcessAlive(daemonPid)) {
          if (await this.isOwnedServerProcess(daemonPid, daemonStartedAt)) {
            try { process.kill(daemonPid, 'SIGKILL'); } catch {}
          }
        }

        const childDead = childPid ? await this.waitForProcessExit(childPid, 2000) : true;
        const daemonDead = daemonPid ? await this.waitForProcessExit(daemonPid, 2000) : true;

        if (!childDead || !daemonDead) {
          log.error('Failed to stop: process is still running', { childPid, daemonPid, childDead, daemonDead });
          this.updateStatus('error', 'Failed to stop: server process is still running');
          return;
        }
      }

      if (lease && !daemonPid) {
        this.updateStatus('error', 'Server identity could not be confirmed; GPU support remains protected');
        return;
      }
      this.childProcess = null;
      this.pidFile = null;
      this.startedAt = null;
      this.serverVersion = null;
      this.setDiagnostics(undefined);
      this.setModelDownload(undefined);
      this.setEngineStatus(undefined);
      this.setRuntime(undefined);
      this.activeRuntimeLease = null;

      if (lease) {
        try {
          await lease.release();
        } catch (leaseErr) {
          log.warn('Failed to release runtime lease on stop', { error: leaseErr });
        }
      }
      await this.replaceRuntimeLease(null, [], false);

      this.updateStatus('stopped');
    } catch (error) {
      log.error('Error stopping server', { error: error as Error });
      this.updateStatus('error', 'Failed to stop server');
    }
  }

  /**
   * Restart the server.
   */
  restart(): Promise<void> {
    if (!this.managed && !this.startInFlight) {
      log.info('Server is not managed, cannot restart a detected process');
      return Promise.resolve();
    }

    log.info('Restarting server');
    return this.enqueueLifecycle('restart', async () => {
      await this.stopOnce();
      if (!this.cleaningUp) await this.startOnce();
    });
  }

  /**
   * Cleanup on app quit.
   */
  async cleanup(): Promise<void> {
    this.cleaningUp = true;
    this.stopHealthPolling();

    if (this.childProcess || this.startInFlight || this.lastLifecycleRequest) {
      log.info('Cleaning up server on app quit');
      await this.enqueueLifecycle('cleanup', () => this.stopOnce());
    }

    this.clearPendingLogDelivery();
  }
}
