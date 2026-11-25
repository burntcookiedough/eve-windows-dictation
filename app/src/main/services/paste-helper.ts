import { spawn } from 'child_process';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'node:stream';
import { buildPersistentPasteScript } from './paste-helper-script.js';
import { perfTraceManager } from './perf-trace.js';

const FOREGROUND_TIMEOUT_MS = 100;
const PASTE_TIMEOUT_MS = 5000;
const MAX_REPLY_LENGTH = 4096;

type RequestType = 'ready' | 'foreground' | 'paste' | 'commit' | 'discard';

export type AuthorizePaste = (dispatch: () => void | Promise<void>) => Promise<void>;

interface PendingRequest {
  type: Exclude<RequestType, 'discard'> | 'authorizing';
  timeout: ReturnType<typeof setTimeout>;
  expiresAt: number;
  perfTraceId?: string;
  authorize?: AuthorizePaste;
  resolve: (handle: number | null) => void;
  reject: (error: Error) => void;
}

interface HelperConnection {
  child: ChildProcessByStdio<Writable, Readable, null>;
  requests: Map<number, PendingRequest>;
  output: string;
  ready: boolean;
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
    // A request queued behind compilation or another operation could sample a
    // window focused after recording began. Warm a cold helper for next time.
    if (!this.connection) {
      if (!this.stopped) void this.warmUp().catch(() => {});
      return null;
    }
    if (!this.connection.ready || this.connection.requests.size > 0) return null;
    return this.request('foreground', FOREGROUND_TIMEOUT_MS);
  }

  async paste(targetWindowHandle: number, perfTraceId?: string, authorize?: AuthorizePaste): Promise<void> {
    if (!Number.isSafeInteger(targetWindowHandle) || targetWindowHandle <= 0) {
      throw new Error('Invalid paste target window handle');
    }
    await this.request('paste', PASTE_TIMEOUT_MS, targetWindowHandle, perfTraceId, authorize);
  }

  shutdown(): void {
    this.stopped = true;
    if (this.connection) {
      this.disconnect(this.connection, 'Paste helper shut down');
    }
  }

  private request(
    type: 'ready' | 'foreground' | 'paste',
    timeoutMs: number,
    targetWindowHandle?: number,
    perfTraceId?: string,
    authorize?: AuthorizePaste
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
      const expiresAt = performance.now() + timeoutMs;
      const timeout = setTimeout(() => this.disconnect(connection, 'Paste helper request timed out'), timeoutMs);
      connection.requests.set(id, { type, timeout, expiresAt, perfTraceId, authorize, resolve, reject });
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
    const connection: HelperConnection = { child, requests: new Map(), output: '', ready: false };
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

    if (performance.now() >= pending.expiresAt) {
      this.disconnect(connection, 'Paste helper request timed out');
      return true;
    }
    if (pending.type === 'paste' && type === 'prepared') {
      connection.ready = true;
      pending.type = 'authorizing';
      void this.authorizeCommit(connection, id, pending);
      return true;
    }

    let foreground: number | null = null;
    let failure: Error | null = null;
    switch (pending.type) {
      case 'ready':
        if (type !== 'ready') return false;
        connection.ready = true;
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

  private async authorizeCommit(connection: HelperConnection, id: number, pending: PendingRequest): Promise<void> {
    const commit = () => {
      if (this.connection !== connection || connection.requests.get(id) !== pending
        || pending.type !== 'authorizing') return;
      if (performance.now() >= pending.expiresAt) {
        this.disconnect(connection, 'Paste helper request timed out');
        return;
      }
      // From the instant we hand off commit, a lost reply cannot tell us whether SendInput ran.
      pending.type = 'commit';
      this.send(connection, { id, type: 'commit' });
    };
    try {
      if (pending.authorize) await pending.authorize(commit);
      else commit();
    } catch {
      // Failed authorization provides no basis to send input.
    } finally {
      if (this.connection === connection && pending.type === 'authorizing') {
        connection.requests.delete(id);
        clearTimeout(pending.timeout);
        this.send(connection, { id, type: 'discard' });
        pending.resolve(null);
      }
    }
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
