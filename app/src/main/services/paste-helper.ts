import { spawn } from 'child_process';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'node:stream';
import { buildPersistentPasteScript } from './paste-helper-script.js';
import { perfTraceManager } from './perf-trace.js';

const FOREGROUND_TIMEOUT_MS = 2000;
const PASTE_TIMEOUT_MS = 5000;
const MAX_REPLY_LENGTH = 4096;

type RequestType = 'ready' | 'foreground' | 'paste' | 'commit';

interface PendingRequest {
  type: RequestType;
  timeout: ReturnType<typeof setTimeout>;
  perfTraceId?: string;
  resolve: (handle: number | null) => void;
  reject: (error: Error) => void;
}

interface HelperConnection {
  child: ChildProcessByStdio<Writable, Readable, null>;
  requests: Map<number, PendingRequest>;
  output: string;
}

export class PasteHelperUnavailableError extends Error {
  constructor(message: string, readonly allowFallback: boolean) {
    super(message);
  }
}

export class PersistentPasteHelper {
  private connection: HelperConnection | null = null;
  private nextId = 0;
  private stopped = false;

  async warmUp(): Promise<void> {
    await this.request('ready', PASTE_TIMEOUT_MS);
  }

  async foreground(): Promise<number | null> {
    return this.request('foreground', FOREGROUND_TIMEOUT_MS);
  }

  async paste(targetWindowHandle: number, perfTraceId?: string): Promise<void> {
    // JSON serializes non-finite numbers as null, which would become an untargeted paste.
    if (!Number.isSafeInteger(targetWindowHandle)) throw new Error('Invalid paste target window handle');
    await this.request('paste', PASTE_TIMEOUT_MS, targetWindowHandle, perfTraceId);
  }

  shutdown(): void {
    this.stopped = true;
    if (this.connection) {
      this.disconnect(this.connection, 'Paste helper shut down');
    }
  }

  private request(
    type: Exclude<RequestType, 'commit'>,
    timeoutMs: number,
    targetWindowHandle?: number,
    perfTraceId?: string
  ): Promise<number | null> {
    if (this.stopped) {
      return Promise.reject(new PasteHelperUnavailableError('Paste helper shut down', false));
    }
    let connection: HelperConnection;
    try {
      connection = this.connection ?? this.start();
    } catch {
      return Promise.reject(new PasteHelperUnavailableError('Could not start paste helper', true));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.disconnect(connection, 'Paste helper request timed out'), timeoutMs);
      connection.requests.set(id, { type, timeout, perfTraceId, resolve, reject });
      if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperRequestSentAt');
      this.send(connection, { id, type, targetWindowHandle });
    });
  }

  private start(): HelperConnection {
    const script = Buffer.from(buildPersistentPasteScript(), 'utf16le').toString('base64');
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const connection: HelperConnection = { child, requests: new Map(), output: '' };
    this.connection = connection;
    child.on('error', () => this.disconnect(connection, 'Paste helper process failed'));
    child.on('close', () => this.disconnect(connection, 'Paste helper exited'));
    child.stdin.on('error', () => this.disconnect(connection, 'Paste helper input closed'));
    child.stdout.on('error', () => this.disconnect(connection, 'Paste helper output failed'));
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.connection !== connection) return;
      connection.output += chunk;
      let newline = connection.output.indexOf('\n');
      while (newline !== -1 && newline <= MAX_REPLY_LENGTH) {
        const line = connection.output.slice(0, newline);
        connection.output = connection.output.slice(newline + 1);
        if (!this.receive(connection, line)) {
          this.disconnect(connection, 'Malformed paste helper response');
          return;
        }
        if (this.connection !== connection) return;
        newline = connection.output.indexOf('\n');
      }
      if (connection.output.length > MAX_REPLY_LENGTH) {
        this.disconnect(connection, 'Oversized paste helper response');
      }
    });
    return connection;
  }

  private send(
    connection: HelperConnection,
    request: { id: number; type: RequestType; targetWindowHandle?: number }
  ): void {
    try {
      connection.child.stdin.write(JSON.stringify(request) + '\n');
    } catch {
      this.disconnect(connection, 'Could not write paste helper request');
    }
  }

  private receive(connection: HelperConnection, line: string): boolean {
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      return false;
    }
    if (!response || typeof response !== 'object') return false;
    const { id, type, handle, error } = response as Record<string, unknown>;
    if (typeof id !== 'number') return false;
    const pending = connection.requests.get(id);
    if (!pending) return false;

    if (pending.type === 'paste' && type === 'prepared') {
      // The prepare message cannot send keys. From the instant we hand off
      // commit, a lost reply cannot tell us whether SendInput already ran.
      pending.type = 'commit';
      this.send(connection, { id, type: 'commit' });
      return true;
    }

    let foreground: number | null = null;
    let failure: Error | null = null;
    switch (pending.type) {
      case 'ready':
        if (type !== 'ready') return false;
        break;
      case 'foreground':
        if (type !== 'foreground' || typeof handle !== 'number' || !Number.isSafeInteger(handle)) return false;
        foreground = handle > 0 ? handle : null;
        break;
      case 'commit':
        if (type === 'failed' && typeof error === 'string') failure = new Error(error);
        else if (type !== 'pasted') return false;
        break;
      default:
        return false;
    }

    connection.requests.delete(id);
    clearTimeout(pending.timeout);
    if (pending.perfTraceId) perfTraceManager.mark(pending.perfTraceId, 'pasteHelperResponseAt');
    if (failure) pending.reject(failure);
    else pending.resolve(foreground);
    return true;
  }

  private disconnect(connection: HelperConnection, reason: string): void {
    if (this.connection !== connection) return;
    this.connection = null;
    connection.child.kill();
    for (const pending of connection.requests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new PasteHelperUnavailableError(reason, !this.stopped && pending.type !== 'commit'));
    }
    connection.requests.clear();
  }
}

export const pasteHelper = new PersistentPasteHelper();
