import { createHash } from 'node:crypto';
import { app, clipboard, ClipboardItem } from 'electron';
import { execFile } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../lib/logger.js';
import { isPerfTraceEnabled, perfTraceManager } from './perf-trace.js';
import { isClipboardSequence, isPasteAbortCode, NativePasteAbortedError, PasteHelperUnavailableError, pasteHelper } from './paste-helper.js';
import type { AuthorizePaste } from './paste-helper.js';
import { buildSendInputScriptContent, PasteAbortCode } from './paste-helper-script.js';

export { buildSendInputScriptContent } from './paste-helper-script.js';

const log = createLogger('Clipboard');
const PASTE_FOCUS_SETTLE_DELAY_MS = 120;
const MIN_RESTORE_DELAY_MS = 750;
const PASTE_PROCESS_TIMEOUT_MS = 5000;
let pasteLifetime = new AbortController();

// VBScript for keyboard simulation — much faster startup than PowerShell (~50ms vs ~300ms).
// Written to userData once and reused via cscript.
let pasteScriptPath: string | null = null;
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

function ensurePasteScript(): string {
  if (pasteScriptPath) return pasteScriptPath;
  pasteScriptPath = join(app.getPath('userData'), 'paste-helper.vbs');
  if (!existsSync(pasteScriptPath)) {
    writeFileSync(pasteScriptPath, 'CreateObject("WScript.Shell").SendKeys "^v"\n');
    log.debug('Created paste helper script', { path: pasteScriptPath });
  }
  return pasteScriptPath;
}

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
export type PasteSkipReason = 'no_target' | 'clipboard_changed' | 'foreground_changed' | 'superseded';
export type ClipboardPasteOutcome =
  | { kind: 'pasted' }
  | { kind: 'skipped_unsafe'; reason: PasteSkipReason; copied: boolean }
  | { kind: 'failed' };

export async function copyToClipboard(text: string, perfTraceId?: string): Promise<ClipboardCopyOutcome> {
  log.debug('Writing text', { length: text.length });
  latestPasteGeneration += 1;
  return enqueuePasteCriticalSection(async () => {
    if (activePasteSequence) {
      discardPasteSequence(activePasteSequence);
    }
    try {
      const writeStart = perfTraceId && isPerfTraceEnabled() ? performance.now() : null;
      await clipboard.writeText(text);
      if (writeStart !== null) {
        const completedAt = performance.now();
        perfTraceManager.output(perfTraceId, 'clipboard', completedAt - writeStart, completedAt);
      }
    } catch {
      log.error('Failed to write text to clipboard');
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

async function restoreClipboardSnapshot(snapshot: ClipboardSnapshot): Promise<void> {
  const [firstItem] = snapshot.items;
  if (snapshot.items.length === 0) {
    clipboard.clear();
  } else if (snapshot.items.length === 1 && firstItem?.types.length === 1
    && firstItem.types[0] === 'text/plain') {
    const text = await firstItem.getType('text/plain');
    await clipboard.writeText(await text.text());
  } else {
    // Electron commits all items and formats in one atomic clipboard write.
    await clipboard.write(snapshot.items);
  }
}

export async function getForegroundWindowHandle(): Promise<number | null> {
  try {
    return await pasteHelper.foreground();
  } catch {
    return null;
  }
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
  method: 'sendinput' | 'vbscript',
  targetWindowHandle: number,
  clipboardSequence: number | null,
  perfTraceId?: string,
  authorize: AuthorizePaste = async dispatch => dispatch()
): Promise<boolean> {
  const { signal } = pasteLifetime;
  if (signal.aborted) return false;
  if (!Number.isSafeInteger(targetWindowHandle) || targetWindowHandle <= 0) {
    throw new Error('Invalid paste target window handle');
  }
  let dispatched = false;
  const dispatchIfAuthorized: AuthorizePaste = dispatch => authorize(() => {
    if (signal.aborted) return;
    dispatched = true;
    return dispatch();
  });
  try {
    if (method === 'vbscript') {
      const foreground = await getForegroundWindowHandle();
      await dispatchIfAuthorized(() => {
        if (foreground !== targetWindowHandle) throw new NativePasteAbortedError(PasteAbortCode.ForegroundChanged);
        return runOneShotPaste('cscript', ['//NoLogo', '//B', ensurePasteScript()], signal, perfTraceId);
      });
    } else {
      if (!isClipboardSequence(clipboardSequence)) return false;
      try {
        await pasteHelper.paste(targetWindowHandle, clipboardSequence, perfTraceId, dispatchIfAuthorized);
      } catch (error) {
        if (!(error instanceof PasteHelperUnavailableError && error.allowFallback)) throw error;
        if (signal.aborted) return false;
        dispatched = false;
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureSendInputScript(),
          '-TargetWindowHandle', String(targetWindowHandle), '-ClipboardSequence', String(clipboardSequence)];
        await dispatchIfAuthorized(() => runOneShotPaste('powershell', args, signal, perfTraceId));
      }
    }
  } catch (error) {
    if (signal.aborted) return false;
    if (error instanceof NativePasteAbortedError) throw error;
    log.error('Paste dispatch failed', { error: error as Error });
    throw error;
  }
  return dispatched;
}

async function runOneShotPaste(command: string, args: string[], signal: AbortSignal, perfTraceId?: string): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperRequestSentAt');
    execFile(command, args, {
      windowsHide: true,
      timeout: PASTE_PROCESS_TIMEOUT_MS,
      signal,
    }, (error) => {
      if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperResponseAt');
      if (command === 'powershell' && isPasteAbortCode(error?.code)) reject(new NativePasteAbortedError(error.code));
      else if (error) reject(error);
      else resolve();
    });
  });
}

export interface PasteTextOptions {
  perfTraceId?: string;
  restoreClipboard: boolean;
  restoreDelayMs: number;
  method: 'sendinput' | 'vbscript';
  targetWindowHandle: number | null;
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

async function beginPasteOperation(): Promise<{ sequence: PasteSequence | null; baselineSnapshot: ClipboardSnapshot }> {
  const snapshot = await readClipboardSnapshot();
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

      try {
        const currentSnapshot = await readClipboardSnapshot();
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

        await restoreClipboardSnapshot(sequence.baselineSnapshot);
      } catch {
        log.error('Failed to restore clipboard');
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
  const { signal } = pasteLifetime;
  const skip = (reason: PasteSkipReason, copied = false): ClipboardPasteOutcome =>
    ({ kind: 'skipped_unsafe', reason, copied });
  if (signal.aborted) return skip('superseded');
  const target = options.targetWindowHandle;
  if (target === null || !Number.isSafeInteger(target) || target <= 0) return skip('no_target');

  const pasteGeneration = ++latestPasteGeneration;
  const isSuperseded = () => signal.aborted || pasteGeneration !== latestPasteGeneration;
  let sequence: PasteSequence | null = null;
  let baselineSnapshot: ClipboardSnapshot | null = null;

  return enqueuePasteCriticalSection(async () => {
    let clipboardOwnershipSignature: string | null = null;
    try {
      if (isSuperseded()) return skip('superseded');
      if (options.restoreClipboard) {
        const operation = await beginPasteOperation();
        if (isSuperseded()) return skip('superseded');
        sequence = operation.sequence;
        baselineSnapshot = operation.baselineSnapshot;
      } else if (activePasteSequence) {
        discardPasteSequence(activePasteSequence);
      }

      const writeStart = options.perfTraceId && isPerfTraceEnabled() ? performance.now() : null;
      await clipboard.writeText(text);
      const sequenceRequest = options.method === 'sendinput' && !signal.aborted
        ? pasteHelper.clipboardSequence().catch(() => null)
        : null;
      if (writeStart !== null) {
        const completedAt = performance.now();
        perfTraceManager.output(options.perfTraceId, 'clipboard', completedAt - writeStart, completedAt);
      }
      const writtenSnapshot = await readClipboardSnapshot();
      if (writtenSnapshot.text !== text) {
        if (sequence && activePasteSequence === sequence) {
          discardPasteSequence(sequence);
        }
        return skip('clipboard_changed');
      }

      clipboardOwnershipSignature = writtenSnapshot.signature;
      if (!sequence && baselineSnapshot) {
        sequence = activatePasteSequence(baselineSnapshot, clipboardOwnershipSignature);
      } else if (sequence && activePasteSequence === sequence) {
        sequence.ownedSignature = clipboardOwnershipSignature;
      }

      const clipboardSequence = await sequenceRequest;
      if (isSuperseded()) return skip('superseded');
      const sequenceUnavailable = options.method === 'sendinput' && clipboardSequence === null;
      if (!sequenceUnavailable) {
        await delay(PASTE_FOCUS_SETTLE_DELAY_MS);
        if (options.perfTraceId) perfTraceManager.mark(options.perfTraceId, 'pasteSettleCompletedAt');
        if (isSuperseded()) return skip('superseded');
      }
      const currentSnapshot = await readClipboardSnapshot();
      if (isSuperseded()) return skip('superseded');
      const stillOwnsClipboard = currentSnapshot.signature === clipboardOwnershipSignature;
      if (options.perfTraceId) perfTraceManager.mark(options.perfTraceId, 'pasteOwnershipCheckedAt');
      if (!stillOwnsClipboard) {
        if (sequence && activePasteSequence === sequence) {
          discardPasteSequence(sequence);
        }
        return skip('clipboard_changed');
      }
      if (sequenceUnavailable) {
        return skip('clipboard_changed', !options.restoreClipboard);
      }

      const authorize: AuthorizePaste = async dispatch => {
        if (isSuperseded()) return;
        const snapshot = await readClipboardSnapshot().catch(() => null);
        if (!snapshot || isSuperseded()) return;
        if (snapshot.signature !== clipboardOwnershipSignature) {
          if (sequence) discardPasteSequence(sequence);
          return;
        }
        return dispatch();
      };
      const dispatched = await simulatePaste(options.method, target, clipboardSequence, options.perfTraceId, authorize);
      if (dispatched) return { kind: 'pasted' };
      return skip(isSuperseded() ? 'superseded' : 'clipboard_changed');
    } catch (error) {
      if (isSuperseded()) return skip('superseded');
      if (error instanceof NativePasteAbortedError) {
        if (sequence) discardPasteSequence(sequence);
        return error.code === PasteAbortCode.ClipboardChanged
          ? skip('clipboard_changed')
          : skip('foreground_changed', true);
      }
      log.error('Could not complete clipboard paste');
      return { kind: 'failed' };
    } finally {
      if (!sequence && options.restoreClipboard && pasteGeneration === latestPasteGeneration) {
        sequence = activePasteSequence;
      }
      if (sequence && activePasteSequence === sequence) {
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
