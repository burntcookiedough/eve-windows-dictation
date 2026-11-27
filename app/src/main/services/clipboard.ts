import { createHash } from 'node:crypto';
import { app, clipboard, ClipboardItem } from 'electron';
import { execFile } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../lib/logger.js';
import { isPerfTraceEnabled, perfTraceManager, type ForegroundSnapshotFailure, type PastePreDispatchReason } from './perf-trace.js';
import { isClipboardSequence, isPasteAbortCode, NativePasteAbortedError, PasteHelperUnavailableError, pasteHelper } from './paste-helper.js';
import type { AuthorizePaste } from './paste-helper.js';
import { buildSendInputScriptContent, PasteAbortCode } from './paste-helper-script.js';

export { buildSendInputScriptContent } from './paste-helper-script.js';

const log = createLogger('Clipboard');
const PASTE_FOCUS_SETTLE_DELAY_MS = 120;
const MIN_RESTORE_DELAY_MS = 750;
const COPY_READ_TIMEOUT_MS = 1000;
const RESTORE_READ_TIMEOUT_MS = 1000;
const PASTE_PROCESS_TIMEOUT_MS = 5000;
// A paste helper that is still starting gets this long, leaving the rest of the
// delivery deadline for the guarded paste or the copy fallback.
const PASTE_WARM_WAIT_MS = 2500;
const PASTE_DEADLINE_RESERVE_MS = 1500;
let pasteLifetime = new AbortController();

let sendInputScriptPath: string | null = null;
let latestPasteGeneration = 0;
let pasteCriticalSection: Promise<void> = Promise.resolve();

interface ClipboardSnapshot {
  text: string;
  items: Electron.ClipboardItem[];
  signature: string;
}

interface PasteSequence {
  baselineSnapshot: ClipboardSnapshot;
  ownedSignature: string;
  restoreTimer: ReturnType<typeof setTimeout> | null;
}

let activePasteSequence: PasteSequence | null = null;

function ensureSendInputScript(): string {
  if (sendInputScriptPath) return sendInputScriptPath;
  sendInputScriptPath = join(app.getPath('userData'), 'paste-sendinput.ps1');
  writeFileSync(
    sendInputScriptPath,
    buildSendInputScriptContent(),
    'utf8'
  );
  log.debug('Updated SendInput paste helper script', { path: sendInputScriptPath });
  return sendInputScriptPath;
}

export type ClipboardCopyOutcome = { kind: 'copied' } | { kind: 'failed' };
export type PasteSkipReason = 'no_target' | 'paste_unavailable' | 'clipboard_changed' | 'foreground_changed' | 'superseded' | 'expired';
export type ClipboardPasteOutcome =
  | { kind: 'pasted' }
  | { kind: 'skipped_unsafe'; reason: PasteSkipReason; copied: boolean }
  | { kind: 'failed'; clipboardWrite: 'not_attempted' | 'uncertain' | 'written'; dispatch: 'not_attempted' | 'uncertain' };

export async function copyToClipboard(
  text: string,
  perfTraceId?: string,
  signal?: AbortSignal,
  deadlineUnixMs = Infinity,
): Promise<ClipboardCopyOutcome> {
  const expired = () => signal?.aborted || Date.now() >= deadlineUnixMs;
  if (expired()) return { kind: 'failed' };
  log.debug('Writing text', { length: text.length });
  const generation = ++latestPasteGeneration;
  return enqueuePasteCriticalSection(async () => {
    if (expired()) return { kind: 'failed' };
    if (activePasteSequence) {
      discardPasteSequence(activePasteSequence);
    }
    try {
      const writeStart = perfTraceId && isPerfTraceEnabled() ? performance.now() : null;
      // Electron provides no cancellation for a submitted write. Keep it ordered
      // with later Eve writes and ignore its completion after the session expires.
      if (expired()) return { kind: 'failed' };
      await clipboard.writeText(text);
      if (expired()) return { kind: 'failed' };
      const writtenAt = writeStart !== null ? performance.now() : null;
      const readTimeout = AbortSignal.timeout(COPY_READ_TIMEOUT_MS);
      const readSignal = signal ? AbortSignal.any([signal, readTimeout]) : readTimeout;
      const verified = await readClipboardWhileActive(readSignal, async () => {
        const sequence = await pasteHelper.clipboardSequence().catch(() => null);
        readSignal.throwIfAborted();
        if (await clipboard.readText() !== text) return false;
        readSignal.throwIfAborted();
        return sequence === null || await pasteHelper.clipboardSequence() === sequence;
      });
      if (!verified || expired() || generation !== latestPasteGeneration) return { kind: 'failed' };
      if (writeStart !== null && writtenAt !== null) {
        perfTraceManager.output(perfTraceId, 'clipboard', writtenAt - writeStart, writtenAt);
      }
    } catch {
      log.error('Failed to write or verify clipboard text');
      return { kind: 'failed' };
    }
    return { kind: 'copied' };
  });
}

export async function readFromClipboard(): Promise<string> {
  try {
    return await clipboard.readText();
  } catch {
    log.error('Failed to read text from clipboard');
    throw new Error('Could not read from clipboard.');
  }
}

async function readClipboardSnapshot(): Promise<ClipboardSnapshot> {
  const [text, rawItems] = await Promise.all([clipboard.readText(), clipboard.read()]);
  const items: Electron.ClipboardItem[] = [];
  const signatures: Array<Array<[string, string]>> = [];
  for (const rawItem of rawItems) {
    const payloads: Record<string, Blob | Electron.ClipboardBookmark> = {};
    const hashes: Array<[string, string]> = [];
    for (const type of [...rawItem.types].sort()) {
      if (type === 'electron application/bookmark') {
        const bookmark = await rawItem.getType('electron application/bookmark');
        payloads[type] = { title: bookmark.title, url: bookmark.url };
        hashes.push([type, createHash('sha256').update(JSON.stringify(payloads[type])).digest('hex')]);
      } else {
        const payload = await rawItem.getType(type);
        if (!(payload instanceof Blob)) throw new Error('Unreadable clipboard format');
        const bytes = new Uint8Array(await payload.arrayBuffer());
        // Detach from native clipboard ownership before replacing any content.
        payloads[type] = new Blob([bytes], { type });
        hashes.push([type, createHash('sha256').update(bytes).digest('hex')]);
      }
    }
    items.push(new ClipboardItem(payloads));
    signatures.push(hashes);
  }
  return { text, items, signature: JSON.stringify({ text, items: signatures }) };
}

function readClipboardWhileActive<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function prepareClipboardRestore(snapshot: ClipboardSnapshot): Promise<() => void | Promise<void>> {
  const [firstItem] = snapshot.items;
  if (snapshot.items.length === 0) {
    return () => clipboard.clear();
  }
  if (snapshot.items.length === 1 && firstItem?.types.length === 1
    && firstItem.types[0] === 'text/plain') {
    const item = await firstItem.getType('text/plain');
    const text = await item.text();
    return () => clipboard.writeText(text);
  }
  // Electron commits all items and formats in one atomic clipboard write.
  return () => clipboard.write(snapshot.items);
}

export function suspendClipboardPaste(): void {
  pasteLifetime.abort();
  pasteHelper.shutdown();
}

export function resumeClipboardPaste(): void {
  if (!pasteLifetime.signal.aborted) return;
  pasteLifetime = new AbortController();
  pasteHelper.resume();
}

export async function simulatePaste(
  targetWindowHandle: number,
  clipboardSequence: number | null,
  perfTraceId?: string,
  authorize: AuthorizePaste = async dispatch => dispatch(),
  signal = pasteLifetime.signal,
  deadlineUnixMs = Date.now() + PASTE_PROCESS_TIMEOUT_MS,
  onDispatch?: () => void,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (!Number.isSafeInteger(targetWindowHandle) || targetWindowHandle <= 0) {
    throw new Error('Invalid paste target window handle');
  }
  if (Date.now() >= deadlineUnixMs) throw new NativePasteAbortedError(PasteAbortCode.Expired);
  let dispatched = false;
  let expired = false;
  const markDispatched = () => {
    dispatched = true;
    try {
      onDispatch?.();
    } catch {
      log.error('Could not report paste handoff');
    }
  };
  const dispatchIfAuthorized: AuthorizePaste = dispatch => authorize(() => {
    if (signal.aborted) return;
    if (Date.now() >= deadlineUnixMs) {
      expired = true;
      return;
    }
    return dispatch(markDispatched);
  });
  try {
    if (!isClipboardSequence(clipboardSequence)) return false;
    const cancelHelper = () => {
      if (pasteLifetime.signal.aborted) return;
      pasteHelper.cancelPaste();
    };
    signal.addEventListener('abort', cancelHelper, { once: true });
    try {
      try {
        await pasteHelper.paste(targetWindowHandle, clipboardSequence, perfTraceId, dispatchIfAuthorized, deadlineUnixMs);
      } finally {
        signal.removeEventListener('abort', cancelHelper);
      }
    } catch (error) {
      if (!(error instanceof PasteHelperUnavailableError && error.allowFallback)) throw error;
      if (signal.aborted) return false;
      if (Date.now() >= deadlineUnixMs) throw new NativePasteAbortedError(PasteAbortCode.Expired);
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureSendInputScript(),
        '-TargetWindowHandle', String(targetWindowHandle), '-ClipboardSequence', String(clipboardSequence),
        '-DeadlineUnixMs', String(deadlineUnixMs)];
      await dispatchIfAuthorized(onHandoff => runOneShotPaste(args, signal, perfTraceId, onHandoff));
    }
  } catch (error) {
    if (signal.aborted) return false;
    if (error instanceof NativePasteAbortedError) throw error;
    log.error('Paste dispatch failed', { error: error as Error });
    throw error;
  }
  if (expired && !dispatched) throw new NativePasteAbortedError(PasteAbortCode.Expired);
  return dispatched;
}

async function runOneShotPaste(args: string[], signal: AbortSignal, perfTraceId?: string, onHandoff?: () => void): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperRequestSentAt');
    onHandoff?.();
    execFile('powershell', args, {
      windowsHide: true,
      timeout: PASTE_PROCESS_TIMEOUT_MS,
      signal,
    }, (error) => {
      if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperResponseAt');
      if (isPasteAbortCode(error?.code)) reject(new NativePasteAbortedError(error.code));
      else if (error) reject(error);
      else resolve();
    });
  });
}

export interface PasteTextOptions {
  perfTraceId?: string;
  restoreClipboard: boolean;
  restoreDelayMs: number;
  targetWindowHandle: number | null;
  snapshotFailure?: ForegroundSnapshotFailure;
  signal?: AbortSignal;
  deadlineUnixMs?: number;
  onDispatch?: () => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discardPasteSequence(sequence: PasteSequence): void {
  if (sequence.restoreTimer) {
    clearTimeout(sequence.restoreTimer);
    sequence.restoreTimer = null;
  }
  if (activePasteSequence === sequence) {
    activePasteSequence = null;
  }
}

async function beginPasteOperation(signal: AbortSignal): Promise<{ sequence: PasteSequence | null; baselineSnapshot: ClipboardSnapshot }> {
  const snapshot = await readClipboardWhileActive(signal, readClipboardSnapshot);
  signal.throwIfAborted();
  const currentSequence = activePasteSequence;

  if (currentSequence) {
    if (currentSequence.ownedSignature === snapshot.signature) {
      if (currentSequence.restoreTimer) {
        clearTimeout(currentSequence.restoreTimer);
        currentSequence.restoreTimer = null;
      }
      return { sequence: currentSequence, baselineSnapshot: currentSequence.baselineSnapshot };
    }
    discardPasteSequence(currentSequence);
  }

  return {
    sequence: null,
    baselineSnapshot: snapshot,
  };
}

function activatePasteSequence(
  baselineSnapshot: ClipboardSnapshot,
  ownedSignature: string
): PasteSequence {
  const sequence: PasteSequence = {
    baselineSnapshot,
    ownedSignature,
    restoreTimer: null,
  };
  activePasteSequence = sequence;
  return sequence;
}

function schedulePasteRestore(
  sequence: PasteSequence,
  pasteGeneration: number,
  clipboardOwnershipSignature: string,
  restoreDelayMs: number
): void {
  if (
    activePasteSequence !== sequence ||
    pasteGeneration !== latestPasteGeneration ||
    sequence.restoreTimer
  ) {
    return;
  }

  const restoreTimer = setTimeout(() => {
    if (sequence.restoreTimer === restoreTimer) {
      sequence.restoreTimer = null;
    }

    if (
      activePasteSequence !== sequence ||
      pasteGeneration !== latestPasteGeneration
    ) {
      return;
    }

    void enqueuePasteCriticalSection(async () => {
      if (
        activePasteSequence !== sequence ||
        pasteGeneration !== latestPasteGeneration
      ) {
        return;
      }

      const signal = AbortSignal.timeout(RESTORE_READ_TIMEOUT_MS);
      let restoreStarted = false;
      try {
        // Finish decoding the baseline before checking who owns the clipboard.
        const restore = await readClipboardWhileActive(signal, () => prepareClipboardRestore(sequence.baselineSnapshot));
        const currentSnapshot = await readClipboardWhileActive(signal, readClipboardSnapshot);
        signal.throwIfAborted();
        if (
          activePasteSequence !== sequence ||
          pasteGeneration !== latestPasteGeneration
        ) {
          return;
        }
        if (currentSnapshot.signature !== clipboardOwnershipSignature) {
          discardPasteSequence(sequence);
          return;
        }

        restoreStarted = true;
        await restore();
      } catch {
        if (signal.aborted && !restoreStarted) log.warn('Clipboard restore read timed out');
        else log.error('Failed to restore clipboard');
      }
      if (activePasteSequence === sequence) {
        activePasteSequence = null;
      }
    }).catch(() => {
      log.error('Failed to restore clipboard');
      discardPasteSequence(sequence);
    });
  }, Math.max(MIN_RESTORE_DELAY_MS, restoreDelayMs));
  sequence.restoreTimer = restoreTimer;
}

function enqueuePasteCriticalSection<T>(operation: () => Promise<T>): Promise<T> {
  const queuedOperation = pasteCriticalSection.then(operation);
  pasteCriticalSection = queuedOperation.then(() => {}, () => {});
  return queuedOperation;
}

export async function pasteText(text: string, options: PasteTextOptions): Promise<ClipboardPasteOutcome> {
  const signal = options.signal ? AbortSignal.any([pasteLifetime.signal, options.signal]) : pasteLifetime.signal;
  let dispatchAttempted = false;
  const report = (reason: PastePreDispatchReason) => perfTraceManager.pastePreDispatch(options.perfTraceId, reason);
  const skip = (reason: PasteSkipReason, copied = false, detail?: PastePreDispatchReason): ClipboardPasteOutcome => {
    if (detail) report(detail);
    else if (reason === 'superseded' && !dispatchAttempted) report(reason);
    return { kind: 'skipped_unsafe', reason, copied };
  };
  if (signal.aborted) return skip('superseded');
  const target = options.targetWindowHandle;
  if (target === null || !Number.isSafeInteger(target) || target <= 0) {
    return skip('no_target', false, options.snapshotFailure ?? 'no_target');
  }

  const pasteGeneration = ++latestPasteGeneration;
  const isSuperseded = () => signal.aborted || pasteGeneration !== latestPasteGeneration;
  let sequence: PasteSequence | null = null;
  let baselineSnapshot: ClipboardSnapshot | null = null;

  return enqueuePasteCriticalSection(async () => {
    let clipboardOwnershipSignature: string | null = null;
    let clipboardWrite: 'not_attempted' | 'uncertain' | 'written' = 'not_attempted';
    let failureReason: PastePreDispatchReason = 'clipboard_baseline_read_failed';
    try {
      if (isSuperseded()) return skip('superseded');
      const warming = pasteHelper.pasteWarmup;
      if (warming === null) return skip('paste_unavailable', false, 'paste_helper_not_ready');
      if (warming) {
        // Sample the native sequence right after the write. Waiting between
        // those operations could bind the sequence of a different clipboard owner.
        const timeLeft = (options.deadlineUnixMs ?? Infinity) - Date.now();
        if (timeLeft <= 0) return skip('expired', false, 'paste_expired');
        const waitMs = Math.min(PASTE_WARM_WAIT_MS, timeLeft - PASTE_DEADLINE_RESERVE_MS);
        if (waitMs <= 0) return skip('paste_unavailable', false, 'paste_helper_not_ready');
        const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(waitMs)]);
        const ready = await readClipboardWhileActive(waitSignal, () => warming.then(() => true)).catch(() => false);
        if (isSuperseded()) return skip('superseded');
        if (!ready) return skip('paste_unavailable', false, 'paste_helper_not_ready');
      }
      if (options.restoreClipboard) {
        const operation = await beginPasteOperation(signal);
        if (isSuperseded()) return skip('superseded');
        sequence = operation.sequence;
        baselineSnapshot = operation.baselineSnapshot;
      } else if (activePasteSequence) {
        discardPasteSequence(activePasteSequence);
      }

      // A helper may have exited while the baseline read was pending.
      if (pasteHelper.pasteWarmup !== undefined) return skip('paste_unavailable', false, 'paste_helper_not_ready');
      const writeStart = options.perfTraceId && isPerfTraceEnabled() ? performance.now() : null;
      failureReason = 'clipboard_write_failed';
      clipboardWrite = 'uncertain';
      await clipboard.writeText(text);
      clipboardWrite = 'written';
      if (isSuperseded()) return skip('superseded');
      const sequenceRequest = pasteHelper.clipboardSequence().catch(() => null);
      if (writeStart !== null) {
        const completedAt = performance.now();
        perfTraceManager.output(options.perfTraceId, 'clipboard', completedAt - writeStart, completedAt);
      }
      failureReason = 'clipboard_written_read_failed';
      const writtenSnapshot = await readClipboardWhileActive(signal, readClipboardSnapshot);
      if (isSuperseded()) return skip('superseded');
      if (writtenSnapshot.text !== text) {
        if (sequence && activePasteSequence === sequence) {
          discardPasteSequence(sequence);
        }
        return skip('clipboard_changed', false, 'clipboard_written_text_changed');
      }

      clipboardOwnershipSignature = writtenSnapshot.signature;
      if (!sequence && baselineSnapshot) {
        sequence = activatePasteSequence(baselineSnapshot, clipboardOwnershipSignature);
      } else if (sequence && activePasteSequence === sequence) {
        sequence.ownedSignature = clipboardOwnershipSignature;
      }

      const clipboardSequence = await sequenceRequest;
      if (isSuperseded()) return skip('superseded');
      const sequenceUnavailable = clipboardSequence === null;
      if (!sequenceUnavailable) {
        await delay(PASTE_FOCUS_SETTLE_DELAY_MS);
        if (options.perfTraceId) perfTraceManager.mark(options.perfTraceId, 'pasteSettleCompletedAt');
        if (isSuperseded()) return skip('superseded');
      }
      failureReason = 'clipboard_ownership_read_failed';
      const currentSnapshot = await readClipboardWhileActive(signal, readClipboardSnapshot);
      if (isSuperseded()) return skip('superseded');
      const stillOwnsClipboard = currentSnapshot.signature === clipboardOwnershipSignature;
      if (options.perfTraceId) perfTraceManager.mark(options.perfTraceId, 'pasteOwnershipCheckedAt');
      if (!stillOwnsClipboard) {
        if (sequence && activePasteSequence === sequence) {
          discardPasteSequence(sequence);
        }
        return skip('clipboard_changed', false, 'clipboard_ownership_changed');
      }
      if (sequenceUnavailable) {
        return skip('clipboard_changed', !options.restoreClipboard, 'clipboard_sequence_unavailable');
      }

      let authorizationFailure: PastePreDispatchReason = 'paste_not_authorized';
      const authorize: AuthorizePaste = async dispatch => {
        if (isSuperseded()) return;
        const snapshot = await readClipboardWhileActive(signal, readClipboardSnapshot).catch(() => null);
        if (isSuperseded()) return;
        if (!snapshot) {
          authorizationFailure = 'clipboard_authorization_read_failed';
          return;
        }
        if (snapshot.signature !== clipboardOwnershipSignature) {
          if (sequence) discardPasteSequence(sequence);
          authorizationFailure = 'clipboard_authorization_changed';
          return;
        }
        return dispatch();
      };
      failureReason = 'paste_prepare_failed';
      const dispatched = await simulatePaste(target, clipboardSequence, options.perfTraceId, authorize, signal, options.deadlineUnixMs, () => {
        dispatchAttempted = true;
        options.onDispatch?.();
      });
      if (signal.aborted) return skip('superseded');
      if (dispatched) return { kind: 'pasted' };
      return isSuperseded() ? skip('superseded') : skip('clipboard_changed', false, authorizationFailure);
    } catch (error) {
      if (isSuperseded()) return skip('superseded');
      if (error instanceof NativePasteAbortedError) {
        if (error.code === PasteAbortCode.Expired) return skip('expired', false, 'paste_expired');
        if (sequence) discardPasteSequence(sequence);
        if (error.code === PasteAbortCode.ClipboardChanged) return skip('clipboard_changed', false, 'native_clipboard_changed');
        const currentSnapshot = await readClipboardWhileActive(signal, readClipboardSnapshot).catch(() => null);
        if (isSuperseded()) return skip('superseded');
        return skip('foreground_changed', currentSnapshot?.signature === clipboardOwnershipSignature, 'native_foreground_changed');
      }
      if (!dispatchAttempted) report(failureReason);
      log.error('Could not complete clipboard paste');
      return { kind: 'failed', clipboardWrite, dispatch: dispatchAttempted ? 'uncertain' : 'not_attempted' };
    } finally {
      if (signal.aborted) {
        if (sequence && activePasteSequence === sequence) discardPasteSequence(sequence);
      } else if (!sequence && options.restoreClipboard && pasteGeneration === latestPasteGeneration) {
        sequence = activePasteSequence;
      }
      if (!signal.aborted && sequence && activePasteSequence === sequence) {
        if (
          options.restoreClipboard &&
          pasteGeneration === latestPasteGeneration
        ) {
          if (sequence.restoreTimer) {
            clearTimeout(sequence.restoreTimer);
            sequence.restoreTimer = null;
          }
          schedulePasteRestore(
            sequence,
            pasteGeneration,
            clipboardOwnershipSignature ?? sequence.ownedSignature,
            options.restoreDelayMs
          );
        } else if (
          pasteGeneration === latestPasteGeneration &&
          activePasteSequence === sequence
        ) {
          activePasteSequence = null;
        }
      }
    }
  });
}
