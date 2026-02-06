import { app, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type { ServerStatus, ServerPidFile, ServerStatePayload, ServerLogEntry } from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ServerManager');

const MAX_LOG_ENTRIES = 500;
const HEALTH_POLL_INTERVAL_MS = 3000;
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 10000;

export class ServerManager {
  private status: ServerStatus = 'idle';
  private childProcess: ChildProcess | null = null;
  private pidFile: ServerPidFile | null = null;
  private logs: ServerLogEntry[] = [];
  private healthPollInterval: ReturnType<typeof setInterval> | null = null;
  private mainWindow: BrowserWindow | null = null;
  private managed = false; // Whether we spawned the server (production) vs detected it (dev)
  private startedAt: number | null = null;

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
  private readPidFile(): ServerPidFile | null {
    const pidPath = this.getPidFilePath();
    try {
      if (!fs.existsSync(pidPath)) {
        return null;
      }
      const content = fs.readFileSync(pidPath, 'utf-8');
      const data = JSON.parse(content) as ServerPidFile;
      if (
        typeof data.pid === 'number' &&
        typeof data.port === 'number' &&
        typeof data.startedAt === 'number'
      ) {
        return data;
      }
      log.warn('PID file has invalid structure');
      return null;
    } catch (error) {
      log.warn('Failed to read PID file', { error: error as Error });
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
  private async checkHealth(port: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`http://localhost:${port}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start health polling for a running server.
   */
  private startHealthPolling(port: number): void {
    this.stopHealthPolling();
    this.healthPollInterval = setInterval(async () => {
      const healthy = await this.checkHealth(port);
      if (!healthy && this.status === 'running') {
        log.warn('Server health check failed');
        this.updateStatus('error', 'Health check failed');
      }
    }, HEALTH_POLL_INTERVAL_MS);
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
      uptime,
      error: errorOverride,
      wsUrl: this.pidFile?.port
        ? `ws://localhost:${this.pidFile.port}/transcribe`
        : undefined,
      managed: this.managed,
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
      this.updateStatus('stopped');
      return false;
    }

    // Check if process is alive
    if (!this.isProcessAlive(pidData.pid)) {
      log.info('PID file exists but process is dead, cleaning up');
      this.cleanupStalePidFile();
      this.updateStatus('stopped');
      return false;
    }

    // Check health
    const healthy = await this.checkHealth(pidData.port);
    if (!healthy) {
      log.warn('Server process alive but not responding to health checks');
      this.updateStatus('error', 'Server not responding');
      return false;
    }

    // Found a healthy server
    this.pidFile = pidData;
    this.startedAt = pidData.startedAt;
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
  private getServerCommand(): { command: string; args: string[]; cwd: string } | null {
    // In production, the server is bundled with the app
    // The exact path depends on how the app is packaged

    // For now, assume the server is in resources/server relative to app path
    const isPackaged = app.isPackaged;

    if (isPackaged) {
      // Production: server is in resources
      const resourcesPath = process.resourcesPath;
      const serverDir = path.join(resourcesPath, 'server');
      const pythonExe = path.join(serverDir, '.venv', 'Scripts', 'python.exe');
      const mainPy = path.join(serverDir, 'src', 'main.py');

      if (!fs.existsSync(pythonExe)) {
        log.error('Server Python not found', { path: pythonExe });
        return null;
      }

      return {
        command: pythonExe,
        args: [mainPy],
        cwd: serverDir,
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
      const healthy = await this.checkHealth(existingPid.port);
      if (healthy) {
        log.info('Found existing healthy server, adopting');
        this.pidFile = existingPid;
        this.startedAt = existingPid.startedAt;
        this.managed = false;
        this.updateStatus('running');
        this.startHealthPolling(existingPid.port);
        return;
      }
      // Process alive but not healthy - try to kill it
      log.warn('Existing server not responding, will attempt to kill');
      try {
        process.kill(existingPid.pid, 'SIGTERM');
        await this.waitForProcessExit(existingPid.pid, 5000);
      } catch {
        // Ignore errors, proceed with starting new server
      }
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
    this.logs = []; // Clear logs for new session

    try {
      this.childProcess = spawn(serverCmd.command, serverCmd.args, {
        cwd: serverCmd.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        env: {
          ...process.env,
          MURMUR_PID_FILE: this.getPidFilePath(),
        },
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

        if (this.status !== 'stopping') {
          // Unexpected exit
          this.updateStatus('error', `Server exited unexpectedly (code: ${code})`);
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
      const pidData = await this.waitForPidFile(START_TIMEOUT_MS);
      if (!pidData) {
        throw new Error('Server did not write PID file within timeout');
      }

      // Wait for health check to pass
      const healthy = await this.waitForHealth(pidData.port, START_TIMEOUT_MS);
      if (!healthy) {
        throw new Error('Server health check did not pass within timeout');
      }

      this.pidFile = pidData;
      this.startedAt = pidData.startedAt;
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
   * Wait for the PID file to appear.
   */
  private async waitForPidFile(timeoutMs: number): Promise<ServerPidFile | null> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const pidData = this.readPidFile();
      if (pidData) {
        return pidData;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  /**
   * Wait for health check to pass.
   */
  private async waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const healthy = await this.checkHealth(port);
      if (healthy) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
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
        try {
          process.kill(this.pidFile.pid, 'SIGTERM');
        } catch {
          // Process may already be gone
        }
      }

      this.childProcess = null;
      this.pidFile = null;
      this.startedAt = null;
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
