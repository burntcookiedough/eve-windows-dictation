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
} from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';
import {
  isOwnedMurmurServerProcess,
  parseServerPidFile,
  parseHealthyResponse,
  type HealthState,
  type ServerProcessSnapshot,
} from './server-health.js';
import {
  START_HEALTH_TIMEOUT_MS,
  START_PID_TIMEOUT_MS,
  waitForPidFile,
} from './server-startup.js';

const log = createLogger('ServerManager');

const MAX_LOG_ENTRIES = 500;
const HEALTH_POLL_INTERVAL_MS = 3000;
const STOP_TIMEOUT_MS = 10000;
const execFileAsync = promisify(execFile);

export class ServerManager {
  private status: ServerStatus = 'idle';
  private childProcess: ChildProcess | null = null;
  private pidFile: ServerPidFile | null = null;
  private logs: ServerLogEntry[] = [];
  private healthPollInterval: ReturnType<typeof setInterval> | null = null;
  private mainWindow: BrowserWindow | null = null;
  private managed = false; // Whether we spawned the server (production) vs detected it (dev)
  private startedAt: number | null = null;
  private serverVersion: string | null = null;
  private diagnostics: ServerDiagnostics | null = null;
  private modelDownload: ModelDownloadState | null = null;
  private engineStatus: EngineStatus | null = null;

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Get the path to the PID file (matches Python pidfile.py logic).
   */
  private getPidFilePath(): string {
    return path.join(app.getPath('userData'), 'server.pid');
  }

  /**
   * Read and parse the PID file.
   */
  private readPidFile(strict = true): ServerPidFile | null {
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
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check server health by hitting the /health endpoint.
   */
  private async getHealthState(port: number): Promise<HealthState> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`http://localhost:${port}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return { healthy: false };
      }

      return parseHealthyResponse(await response.json());
    } catch {
      return { healthy: false };
    }
  }

  /**
   * Start health polling for a running server.
   */
  private startHealthPolling(port: number): void {
    this.stopHealthPolling();
    this.healthPollInterval = setInterval(async () => {
      const health = await this.getHealthState(port);
      if (!health.healthy && this.status === 'running') {
        log.warn('Server health check failed');
        this.setDiagnostics(undefined);
        this.setModelDownload(undefined);
        this.setEngineStatus(undefined);
        this.updateStatus('error', 'Health check failed');
        return;
      }

      const diagnosticsChanged = this.setDiagnostics(health.diagnostics);
      const downloadChanged = this.setModelDownload(health.modelDownload);
      const engineChanged = this.setEngineStatus(health.engineStatus);
      let shouldBroadcast = diagnosticsChanged || downloadChanged || engineChanged;

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
      return isOwnedMurmurServerProcess(
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

  /**
   * Update status and broadcast to renderer.
   */
  private updateStatus(status: ServerStatus, error?: string): void {
    this.status = status;
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
    this.mainWindow.webContents.send(IPC_CHANNELS.SERVER_LOG, entry);
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
      error: errorOverride,
      wsUrl: this.pidFile?.port
        ? `ws://localhost:${this.pidFile.port}/transcribe`
        : undefined,
      managed: this.managed,
      engineStatus: this.engineStatus ?? undefined,
      diagnostics: this.diagnostics ?? undefined,
      modelDownload: this.modelDownload ?? undefined,
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
      this.updateStatus('error', 'Server not responding');
      return false;
    }

    // Found a healthy server
    this.pidFile = pidData;
    this.startedAt = pidData.startedAt;
    this.serverVersion = health.version ?? null;
    this.setDiagnostics(health.diagnostics);
    this.setModelDownload(health.modelDownload);
    this.setEngineStatus(health.engineStatus);
    this.managed = false; // External server
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
  private getServerCommand(): {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  } | null {
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
        },
      };
    } else {
      // Development mode - this shouldn't be called, but provide fallback
      // In dev, the user should run the server manually with `just start`
      log.warn('getServerCommand called in development mode');
      return null;
    }
  }

  /**
   * Start the server (production mode only).
   */
  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') {
      log.info('Server already running or starting');
      return;
    }

    // Check for existing server first
    const existingPid = this.readPidFile();
    if (existingPid && this.isProcessAlive(existingPid.pid)) {
      if (!(await this.isOwnedServerProcess(existingPid.pid, existingPid.startedAt))) {
        log.warn('PID file belongs to an unverified process; refusing replacement', {
          pid: existingPid.pid,
        });
        this.updateStatus('error', 'Server process ownership could not be verified');
        return;
      }

      const health = await this.getHealthState(existingPid.port);
      if (health.healthy) {
        log.info('Found existing healthy server, adopting');
        this.pidFile = existingPid;
        this.startedAt = existingPid.startedAt;
        this.serverVersion = health.version ?? null;
        this.setDiagnostics(health.diagnostics);
        this.setModelDownload(health.modelDownload);
        this.setEngineStatus(health.engineStatus);
        this.managed = false;
        this.updateStatus('running');
        this.startHealthPolling(existingPid.port);
        return;
      }
      log.warn('Existing owned Murmur server is not responding; terminating it');
      try {
        process.kill(existingPid.pid, 'SIGTERM');
        if (!(await this.waitForProcessExit(existingPid.pid, 5000))) {
          this.updateStatus('error', 'Existing server did not stop');
          return;
        }
      } catch {
        this.updateStatus('error', 'Existing server could not be stopped');
        return;
      }
      this.cleanupStalePidFile();
    } else if (existingPid) {
      this.cleanupStalePidFile();
    }

    const serverCmd = this.getServerCommand();
    if (!serverCmd) {
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
    this.logs = []; // Clear logs for new session

    try {
      const spawnStartedAt = Date.now();
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...serverCmd.env,
        MURMUR_PID_FILE: this.getPidFilePath(),
        MURMUR_SETTINGS_FILE: path.join(app.getPath('userData'), 'server-settings.json'),
        MURMUR_PORT: '0',
      };
      // Transformers v5 removes this deprecated variable. HF_HOME and the
      // standard Hugging Face cache discovery continue to work normally.
      delete childEnv.TRANSFORMERS_CACHE;

      this.childProcess = spawn(serverCmd.command, serverCmd.args, {
        cwd: serverCmd.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        env: childEnv,
      });

      // Capture stdout
      this.childProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter((l) => l.trim());
        for (const line of lines) {
          this.addLog('stdout', line);
        }
      });

      // Capture stderr
      this.childProcess.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter((l) => l.trim());
        for (const line of lines) {
          this.addLog('stderr', line);
        }
      });

      // Handle process exit
      this.childProcess.on('exit', (code, signal) => {
        log.info('Server process exited', { code, signal });
        this.childProcess = null;
        this.stopHealthPolling();
        this.pidFile = null;
        this.startedAt = null;
        this.serverVersion = null;
        this.setDiagnostics(undefined);
        this.setModelDownload(undefined);
        this.setEngineStatus(undefined);

        if (this.status !== 'stopping') {
          // Preserve explicit startup/runtime errors already set by start()/stop() logic.
          if (this.status !== 'error') {
            this.updateStatus(
              'error',
              `Server exited unexpectedly (code: ${String(code)}, signal: ${String(signal)})`
            );
          }
        } else {
          this.updateStatus('stopped');
        }
      });

      this.childProcess.on('error', (error) => {
        log.error('Failed to start server process', { error });
        this.childProcess = null;
        this.updateStatus('error', `Failed to start: ${error.message}`);
      });

      // Wait for PID file to appear (indicates server is ready)
      const pidData = await waitForPidFile(
        () => this.readPidFile(false),
        START_PID_TIMEOUT_MS,
        spawnStartedAt,
      );
      if (!pidData) {
        throw new Error('Server did not write PID file within timeout');
      }

      // Wait for health check to pass
      const health = await this.waitForHealth(pidData.port, START_HEALTH_TIMEOUT_MS);
      if (!health) {
        throw new Error('Server health check did not pass within timeout');
      }

      this.pidFile = pidData;
      this.startedAt = pidData.startedAt;
      this.serverVersion = health.version ?? null;
      this.setDiagnostics(health.diagnostics);
      this.setModelDownload(health.modelDownload);
      this.setEngineStatus(health.engineStatus);
      this.updateStatus('running');
      this.startHealthPolling(pidData.port);

      log.info('Server started successfully', { pid: pidData.pid, port: pidData.port });
    } catch (error) {
      log.error('Failed to start server', { error: error as Error });
      this.updateStatus('error', (error as Error).message);

      // Kill the process if it's still running
      if (this.childProcess) {
        this.childProcess.kill('SIGTERM');
        this.childProcess = null;
      }
    }
  }

  /**
   * Wait for health check to pass.
   */
  private async waitForHealth(port: number, timeoutMs: number): Promise<HealthState | null> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const health = await this.getHealthState(port);
      if (health.healthy) {
        return health;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  /**
   * Wait for a process to exit.
   */
  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
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
  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'idle' || this.status === 'stopping') {
      return;
    }

    if (!this.managed) {
      log.info('Server is not managed (external), cannot stop');
      return;
    }

    log.info('Stopping server');
    this.updateStatus('stopping');
    this.stopHealthPolling();

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

          // Wait for process to exit
          if (this.pidFile?.pid) {
            const exited = await this.waitForProcessExit(this.pidFile.pid, STOP_TIMEOUT_MS);
            if (exited) {
              log.info('Server stopped gracefully');
              this.childProcess = null;
              this.pidFile = null;
              this.startedAt = null;
              this.serverVersion = null;
              this.setDiagnostics(undefined);
              this.setModelDownload(undefined);
              this.setEngineStatus(undefined);
              this.updateStatus('stopped');
              return;
            }
          }
        } catch (error) {
          log.warn('Graceful shutdown failed', { error: error as Error });
        }
      }

      // Force kill if graceful shutdown failed
      if (this.childProcess) {
        log.info('Force killing server process');
        this.childProcess.kill('SIGTERM');

        // Wait a bit for SIGTERM
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // If still running, SIGKILL
        if (this.childProcess) {
          this.childProcess.kill('SIGKILL');
        }
      } else if (this.pidFile?.pid) {
        // No child process ref but have PID (shouldn't happen but handle it)
        if (await this.isOwnedServerProcess(this.pidFile.pid, this.pidFile.startedAt)) {
          try {
            process.kill(this.pidFile.pid, 'SIGTERM');
          } catch {
            // Process may already be gone
          }
        } else {
          log.warn('Refusing to stop unverified PID', { pid: this.pidFile.pid });
        }
      }

      this.childProcess = null;
      this.pidFile = null;
      this.startedAt = null;
      this.serverVersion = null;
      this.setDiagnostics(undefined);
      this.setModelDownload(undefined);
      this.setEngineStatus(undefined);
      this.updateStatus('stopped');
    } catch (error) {
      log.error('Error stopping server', { error: error as Error });
      this.updateStatus('error', `Failed to stop: ${(error as Error).message}`);
    }
  }

  /**
   * Restart the server.
   */
  async restart(): Promise<void> {
    if (!this.managed) {
      log.info('Server is not managed (external), cannot restart');
      return;
    }

    log.info('Restarting server');
    await this.stop();
    await this.start();
  }

  /**
   * Cleanup on app quit.
   */
  async cleanup(): Promise<void> {
    this.stopHealthPolling();

    if (this.managed && this.childProcess) {
      log.info('Cleaning up server on app quit');
      await this.stop();
    }
  }
}
