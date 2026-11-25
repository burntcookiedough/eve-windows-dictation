import { createHash } from 'node:crypto';
import { app, clipboard, ClipboardItem } from 'electron';
import { execFile } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../lib/logger.js';
import { isPerfTraceEnabled, perfTraceManager } from './perf-trace.js';
import { PasteHelperUnavailableError, pasteHelper } from './paste-helper.js';
import { buildSendInputScriptContent } from './paste-helper-script.js';

export { buildSendInputScriptContent } from './paste-helper-script.js';

const log = createLogger('Clipboard');
const PASTE_FOCUS_SETTLE_DELAY_MS = 120;
const MIN_RESTORE_DELAY_MS = 750;
const PASTE_PROCESS_TIMEOUT_MS = 5000;
const FOREGROUND_WINDOW_TIMEOUT_MS = 2000;

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

export async function copyToClipboard(text: string, perfTraceId?: string): Promise<void> {
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
      throw new Error('Could not write to clipboard.');
    }
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
  } catch (error) {
    if (!(error instanceof PasteHelperUnavailableError && error.allowFallback)) return null;
    return getForegroundWindowHandleOnce();
  }
}

function getForegroundWindowHandleOnce(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class NativeWindow {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@
[NativeWindow]::GetForegroundWindow().ToInt64()
`.trim(),
      ],
      {
        windowsHide: true,
        timeout: FOREGROUND_WINDOW_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) {
          log.error('Failed to capture foreground window', { error });
          resolve(null);
          return;
        }

        const handle = Number.parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(handle) && handle > 0 ? handle : null);
      }
    );
  });
}

export async function simulatePaste(
  method: 'sendinput' | 'vbscript' = 'sendinput',
  targetWindowHandle?: number | null,
  perfTraceId?: string
): Promise<void> {
  const hasTargetWindow = Number.isFinite(targetWindowHandle) && Number(targetWindowHandle) > 0;
  const target = targetWindowHandle ?? 0;

  if (method === 'sendinput') {
    try {
      try {
        await pasteHelper.paste(target, perfTraceId);
      } catch (error) {
        if (!(error instanceof PasteHelperUnavailableError && error.allowFallback)) throw error;
        await sendInputOnce(target, perfTraceId);
      }
      return;
    } catch (error) {
      if (hasTargetWindow) {
        log.error('Targeted SendInput paste failed', { error: error as Error });
      } else {
        log.error('SendInput paste failed', { error: error as Error });
      }
      throw error;
    }
  }

  const script = ensurePasteScript();
  return new Promise<void>((resolve, reject) => {
    if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperRequestSentAt');
    execFile('cscript', ['//NoLogo', '//B', script], (error) => {
      if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperResponseAt');
      if (error) {
        log.error('Failed to simulate paste', { error });
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sendInputOnce(targetWindowHandle: number, perfTraceId?: string): Promise<void> {
  const script = ensureSendInputScript();
  return new Promise<void>((resolve, reject) => {
    if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperRequestSentAt');
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-TargetWindowHandle',
        String(targetWindowHandle),
      ],
      {
        windowsHide: true,
        timeout: PASTE_PROCESS_TIMEOUT_MS,
      },
      (error) => {
        if (perfTraceId) perfTraceManager.mark(perfTraceId, 'pasteHelperResponseAt');
        if (error) reject(error);
        else resolve();
      }
    );
  });
}

export interface PasteTextOptions {
  perfTraceId?: string;
  restoreClipboard: boolean;
  restoreDelayMs: number;
  method: 'sendinput' | 'vbscript';
  targetWindowHandle?: number | null;
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

function enqueuePasteCriticalSection(operation: () => Promise<void>): Promise<void> {
  const queuedOperation = pasteCriticalSection.then(operation);
  pasteCriticalSection = queuedOperation.catch(() => {});
  return queuedOperation;
}

export async function pasteText(text: string, options: PasteTextOptions): Promise<void> {
  const pasteGeneration = ++latestPasteGeneration;
  let sequence: PasteSequence | null = null;
  let baselineSnapshot: ClipboardSnapshot | null = null;

  return enqueuePasteCriticalSection(async () => {
    let clipboardOwnershipSignature: string | null = null;
    try {
      if (pasteGeneration !== latestPasteGeneration) return;
      if (options.restoreClipboard) {
        const operation = await beginPasteOperation();
        if (pasteGeneration !== latestPasteGeneration) return;
        sequence = operation.sequence;
        baselineSnapshot = operation.baselineSnapshot;
      } else if (activePasteSequence) {
        discardPasteSequence(activePasteSequence);
      }

      const writeStart = options.perfTraceId && isPerfTraceEnabled() ? performance.now() : null;
      await clipboard.writeText(text);
      if (writeStart !== null) {
        const completedAt = performance.now();
        perfTraceManager.output(options.perfTraceId, 'clipboard', completedAt - writeStart, completedAt);
      }
      const writtenSnapshot = await readClipboardSnapshot();
      if (writtenSnapshot.text !== text) {
        if (sequence && activePasteSequence === sequence) {
          discardPasteSequence(sequence);
        }
        return;
      }

      clipboardOwnershipSignature = writtenSnapshot.signature;
      if (!sequence && baselineSnapshot) {
        sequence = activatePasteSequence(baselineSnapshot, clipboardOwnershipSignature);
      } else if (sequence && activePasteSequence === sequence) {
        sequence.ownedSignature = clipboardOwnershipSignature;
      }

      if (pasteGeneration !== latestPasteGeneration) return;
      await delay(PASTE_FOCUS_SETTLE_DELAY_MS);
      if (options.perfTraceId) perfTraceManager.mark(options.perfTraceId, 'pasteSettleCompletedAt');
      if (pasteGeneration !== latestPasteGeneration) return;
      const currentSnapshot = await readClipboardSnapshot();
      if (pasteGeneration !== latestPasteGeneration) return;
      const stillOwnsClipboard = currentSnapshot.signature === clipboardOwnershipSignature;
      if (options.perfTraceId) perfTraceManager.mark(options.perfTraceId, 'pasteOwnershipCheckedAt');
      if (!stillOwnsClipboard) {
        if (sequence && activePasteSequence === sequence) {
          discardPasteSequence(sequence);
        }
        return;
      }
      if (pasteGeneration !== latestPasteGeneration) return;
      await simulatePaste(options.method, options.targetWindowHandle, options.perfTraceId);
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
