import { spawn } from 'child_process';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'node:stream';
import { buildForegroundSnapshotScript, buildPersistentPasteScript, PasteAbortCode } from './paste-helper-script.js';
import { foregroundRejections, perfTraceManager, type ForegroundRejection, type ForegroundSnapshotFailure } from './perf-trace.js';

const SNAPSHOT_TIMEOUT_MS = 100;
const PASTE_TIMEOUT_MS = 5000;
const MAX_REPLY_LENGTH = 4096;

type RequestType = 'ready' | 'foreground' | 'sequence' | 'paste' | 'commit' | 'discard';
type HelperChannel = 'paste' | 'snapshot';
type NativePasteAbortCode = typeof PasteAbortCode[keyof typeof PasteAbortCode];

export type AuthorizePaste = (dispatch: () => void | Promise<void>) => Promise<void>;
export type ForegroundSnapshot = { handle: number } | { reason: ForegroundSnapshotFailure };

const warmingReasons: readonly ForegroundSnapshotFailure[] = ['helper_absent', 'helper_unready', 'tracker_unready'];

/** The capture failed only because the helpers were still starting. */
export function isPasteWarmingUp(snapshot: ForegroundSnapshot): boolean {
  return 'reason' in snapshot && warmingReasons.includes(snapshot.reason);
}

/** uiohook reports KBDLLHOOKSTRUCT.time, a 32-bit GetTickCount value. */
function isKeydownTick(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

class ForegroundRejectedError extends Error {
  constructor(readonly reason: ForegroundRejection) {
    super('Foreground capture rejected');
  }
}

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
  channel: HelperChannel;
  child: ChildProcessByStdio<Writable, Readable, null>;
  requests: Map<number, PendingRequest>;
  output: string;
  ready: boolean;
  warming?: Promise<number | null>;
}

interface PasteRequest {
  targetWindowHandle?: number;
  clipboardSequence?: number;
  deadlineUnixMs?: number;
  keydownTick?: number;
  perfTraceId?: string;
  authorize?: AuthorizePaste;
}

export function isClipboardSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

export function isPasteAbortCode(value: unknown): value is NativePasteAbortCode {
  return value === PasteAbortCode.ClipboardChanged || value === PasteAbortCode.ForegroundChanged || value === PasteAbortCode.Expired;
}

export class NativePasteAbortedError extends Error {
  constructor(readonly code: NativePasteAbortCode) {
    super({
      [PasteAbortCode.ClipboardChanged]: 'Clipboard changed before paste',
      [PasteAbortCode.ForegroundChanged]: 'Foreground changed before paste',
      [PasteAbortCode.Expired]: 'Deadline expired before paste',
    }[code]);
  }
}

export class PasteHelperUnavailableError extends Error {
  constructor(message: string, readonly allowFallback: boolean, readonly timedOut = false) {
    super(message);
  }
}

export class PersistentPasteHelper {
  private readonly connections: Partial<Record<HelperChannel, HelperConnection>> = {};
  private nextId = 0;
  private stopped = false;
  private autoPaste = true;

  async warmUp(): Promise<void> {
    const results = await Promise.allSettled([this.warmChannel('paste'), this.warmChannel('snapshot')]);
    if (results.some(result => result.status === 'rejected')) throw new Error('Could not warm paste helpers');
  }

  /**
   * Follows the auto-paste setting. Enabling warms both helpers in the
   * background. Disabling releases the snapshot helper once any accepted
   * capture has settled, and stops both helpers from being replaced.
   */
  setAutoPaste(enabled: boolean): void {
    this.autoPaste = enabled;
    if (enabled) void this.warmUp().catch(() => {});
    else this.releaseSnapshot();
  }

  private releaseSnapshot(): void {
    const connection = this.connections.snapshot;
    if (this.autoPaste || !connection) return;
    for (const pending of connection.requests.values()) {
      if (pending.type === 'foreground') return;
    }
    this.disconnect(connection, 'Auto-paste disabled');
  }

  private async warmChannel(channel: HelperChannel): Promise<void> {
    if (this.stopped || (channel === 'snapshot' && !this.autoPaste)) return;
    const connection = this.connections[channel] ?? this.start(channel);
    if (!connection.ready) {
      connection.warming ??= this.request(channel, 'ready', PASTE_TIMEOUT_MS);
      await connection.warming;
    }
  }

  /**
   * Returns the window that was foreground at the hotkey keydown, or why that
   * cannot be proven. The helper rejects the capture when the foreground
   * changed at or after the keydown, so a later window is never returned.
   * A helper that is not ready yet cannot prove anything about an earlier
   * keydown, so it is warmed for the next hotkey instead of being asked.
   */
  async foreground(keydownTick?: number): Promise<ForegroundSnapshot> {
    const connection = this.connections.snapshot;
    if (!connection) {
      if (!this.stopped && this.autoPaste) void this.warmUp().catch(() => {});
      return { reason: 'helper_absent' };
    }
    if (!connection.ready) return { reason: 'helper_unready' };
    if (!isKeydownTick(keydownTick)) return { reason: 'keydown_unverified' };
    if (connection.requests.size > 0) return { reason: 'helper_busy' };
    try {
      const response = this.request('snapshot', 'foreground', SNAPSHOT_TIMEOUT_MS, { keydownTick });
      if (!this.connections.paste) void this.warmChannel('paste').catch(() => {});
      const handle = await response;
      return handle === null ? { reason: 'no_hwnd' } : { handle };
    } catch (error) {
      if (error instanceof ForegroundRejectedError) return { reason: error.reason };
      return { reason: error instanceof PasteHelperUnavailableError && error.timedOut ? 'rpc_timeout' : 'helper_absent' };
    }
  }

  /**
   * Reads the clipboard sequence for an accepted paste. When the paste helper
   * is still starting after auto-paste was enabled or a crash, waits up to
   * `warmWaitMs` for it rather than giving up on the paste.
   */
  async clipboardSequence(warmWaitMs = 0): Promise<number | null> {
    if (this.stopped) return null;
    if (!this.connections.paste?.ready) {
      if (warmWaitMs <= 0) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const warmed = await Promise.race([
        this.warmChannel('paste').then(() => true, () => false),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), warmWaitMs); }),
      ]);
      clearTimeout(timer);
      if (!warmed || !this.connections.paste?.ready) return null;
    }
    return this.request('paste', 'sequence', SNAPSHOT_TIMEOUT_MS);
  }

  async paste(
    targetWindowHandle: number,
    clipboardSequence: number,
    perfTraceId?: string,
    authorize?: AuthorizePaste,
    deadlineUnixMs = Date.now() + PASTE_TIMEOUT_MS,
  ): Promise<void> {
    if (!Number.isSafeInteger(targetWindowHandle) || targetWindowHandle <= 0) {
      throw new Error('Invalid paste target window handle');
    }
    if (!isClipboardSequence(clipboardSequence)) throw new Error('Invalid paste clipboard sequence');
    await this.request('paste', 'paste', PASTE_TIMEOUT_MS, { targetWindowHandle, clipboardSequence, deadlineUnixMs, perfTraceId, authorize });
  }

  shutdown(): void {
    this.stopped = true;
    for (const connection of Object.values(this.connections)) {
      this.disconnect(connection, 'Paste helper shut down');
    }
  }

  cancelPaste(): void {
    const connection = this.connections.paste;
    if (connection) this.disconnect(connection, 'Paste operation cancelled');
  }

  resume(): void {
    this.stopped = false;
  }

  private request(
    channel: HelperChannel,
    type: 'ready' | 'foreground' | 'sequence' | 'paste',
    timeoutMs: number,
    fields?: PasteRequest
  ): Promise<number | null> {
    if (this.stopped) {
      return Promise.reject(new PasteHelperUnavailableError('Paste helper shut down', false));
    }
    let connection: HelperConnection;
    try {
      connection = this.connections[channel] ?? this.start(channel);
    } catch {
      return Promise.reject(new PasteHelperUnavailableError('Could not start paste helper', true));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const expiresAt = performance.now() + timeoutMs;
      const timeout = setTimeout(() => this.disconnect(connection, 'Paste helper request timed out', true), timeoutMs);
      const { perfTraceId, authorize, targetWindowHandle, clipboardSequence, deadlineUnixMs, keydownTick } = fields ?? {};
      connection.requests.set(id, { type, timeout, expiresAt, perfTraceId, authorize, resolve, reject });
      if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperRequestSentAt');
      this.send(connection, {
        id, type, targetWindowHandle, clipboardSequence, keydownTick,
        deadlineUnixMs: type === 'foreground' ? Date.now() + timeoutMs : deadlineUnixMs,
      });
    });
  }

  private start(channel: HelperChannel): HelperConnection {
    const contents = channel === 'snapshot' ? buildForegroundSnapshotScript() : buildPersistentPasteScript();
    const script = Buffer.from(contents, 'utf16le').toString('base64');
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const connection: HelperConnection = { channel, child, requests: new Map(), output: '', ready: false };
    this.connections[channel] = connection;
    child.on('error', () => this.disconnect(connection, 'Paste helper process failed'));
    child.on('close', () => this.disconnect(connection, 'Paste helper exited'));
    child.stdin.on('error', () => this.disconnect(connection, 'Paste helper input closed'));
    child.stdout.on('error', () => this.disconnect(connection, 'Paste helper output failed'));
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.connections[channel] !== connection) return;
      connection.output += chunk;
      let newline = connection.output.indexOf('\n');
      while (newline !== -1 && newline <= MAX_REPLY_LENGTH) {
        const line = connection.output.slice(0, newline);
        connection.output = connection.output.slice(newline + 1);
        if (!this.receive(connection, line)) {
          this.disconnect(connection, 'Malformed paste helper response');
          return;
        }
        if (this.connections[channel] !== connection) return;
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
    request: {
      id: number; type: RequestType; targetWindowHandle?: number; clipboardSequence?: number;
      deadlineUnixMs?: number; keydownTick?: number;
    }
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
    const { id, type, handle, sequence, code, error, reason } = response as Record<string, unknown>;
    if (typeof id !== 'number') return false;
    const pending = connection.requests.get(id);
    if (!pending) return false;

    if (performance.now() >= pending.expiresAt) {
      this.disconnect(connection, 'Paste helper request timed out', true);
      return true;
    }
    if (pending.type === 'paste' && type === 'prepared') {
      connection.ready = true;
      pending.type = 'authorizing';
      void this.authorizeCommit(connection, id, pending);
      return true;
    }

    let result: number | null = null;
    let failure: Error | null = null;
    switch (pending.type) {
      case 'ready':
        if (type !== 'ready') return false;
        connection.ready = true;
        break;
      case 'foreground':
        if (type === 'expired') failure = new PasteHelperUnavailableError('Foreground snapshot expired', false, true);
        else if (type === 'rejected') {
          if (!(foregroundRejections as readonly unknown[]).includes(reason)) return false;
          failure = new ForegroundRejectedError(reason as ForegroundRejection);
        } else {
          if (type !== 'foreground' || typeof handle !== 'number' || !Number.isSafeInteger(handle)) return false;
          result = handle > 0 ? handle : null;
        }
        break;
      case 'sequence':
        if (type !== 'sequence' || (sequence !== 0 && !isClipboardSequence(sequence))) return false;
        if (isClipboardSequence(sequence)) result = sequence;
        break;
      case 'commit':
        if (type === 'failed' && typeof error === 'string') failure = new Error(error);
        else if (type === 'aborted' && isPasteAbortCode(code)) failure = new NativePasteAbortedError(code);
        else if (type !== 'pasted') return false;
        break;
      default:
        return false;
    }

    connection.requests.delete(id);
    clearTimeout(pending.timeout);
    if (pending.perfTraceId) perfTraceManager.mark(pending.perfTraceId, 'pasteHelperResponseAt');
    if (failure) pending.reject(failure);
    else pending.resolve(result);
    if (connection.channel === 'snapshot') this.releaseSnapshot();
    return true;
  }

  private async authorizeCommit(connection: HelperConnection, id: number, pending: PendingRequest): Promise<void> {
    const commit = () => {
      if (this.connections.paste !== connection || connection.requests.get(id) !== pending
        || pending.type !== 'authorizing') return;
      if (performance.now() >= pending.expiresAt) {
        this.disconnect(connection, 'Paste helper request timed out', true);
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
      if (this.connections.paste === connection && pending.type === 'authorizing') {
        connection.requests.delete(id);
        clearTimeout(pending.timeout);
        this.send(connection, { id, type: 'discard' });
        pending.resolve(null);
      }
    }
  }

  private disconnect(connection: HelperConnection, reason: string, timedOut = false): void {
    const { channel } = connection;
    if (this.connections[channel] !== connection) return;
    delete this.connections[channel];
    connection.child.kill();
    for (const pending of connection.requests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new PasteHelperUnavailableError(reason, !this.stopped && pending.type !== 'commit', timedOut));
    }
    connection.requests.clear();
    // A failed replacement never reached ready, so it cannot start a retry loop.
    // With auto-paste off, accepted sessions use the one-shot paste fallback.
    if (connection.ready && !this.stopped && this.autoPaste) void this.warmChannel(channel).catch(() => {});
  }
}

export const pasteHelper = new PersistentPasteHelper();
