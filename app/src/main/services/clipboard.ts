import { isPerfTraceEnabled, perfTraceManager } from './perf-trace.js';
import { clipboard } from 'electron';
import { execFile } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { createLogger } from '../lib/logger.js';

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

interface PasteSequence {
  baselineText: string;
  ownedSignature: string;
  restoreTimer: ReturnType<typeof setTimeout> | null;
}

interface ClipboardSnapshot {
  text: string;
  signature: string;
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

export function buildSendInputScriptContent(): string {
  return `
param([long]$TargetWindowHandle = 0)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class NativePaste {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }

  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const ushort VK_CONTROL = 0x11;
  public const ushort VK_MENU = 0x12;
  public const ushort VK_V = 0x56;
  public const int SW_RESTORE = 9;
  private const int FOREGROUND_WAIT_MS = 750;
  private const int FOREGROUND_POLL_MS = 25;

  private static void SendKey(ushort virtualKey, bool keyUp) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].U.ki.wVk = virtualKey;
    inputs[0].U.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
    uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != 1) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }

  private static void AllowForegroundSwitch() {
    SendKey(VK_MENU, false);
    SendKey(VK_MENU, true);
  }

  private static bool WaitForForeground(IntPtr target) {
    int waitedMs = 0;
    while (GetForegroundWindow() != target && waitedMs < FOREGROUND_WAIT_MS) {
      System.Threading.Thread.Sleep(FOREGROUND_POLL_MS);
      waitedMs += FOREGROUND_POLL_MS;
    }
    return GetForegroundWindow() == target;
  }

  public static void Paste(long targetWindowHandle) {
    if (targetWindowHandle != 0) {
      IntPtr target = new IntPtr(targetWindowHandle);
      if (IsWindow(target)) {
        // The overlay is non-focusable, so the original editor normally remains
        // foreground. Do not reactivate an already-active top-level window: some
        // Chromium editors lose their focused child control when that happens.
        if (GetForegroundWindow() != target) {
          AllowForegroundSwitch();
          if (IsIconic(target)) {
            ShowWindow(target, SW_RESTORE);
            System.Threading.Thread.Sleep(80);
          }
          bool activationRequested = SetForegroundWindow(target);
          if (!activationRequested && GetForegroundWindow() != target) {
            throw new InvalidOperationException("Could not focus target window before paste.");
          }
          if (!WaitForForeground(target)) {
            throw new InvalidOperationException("Target window is not foreground before paste.");
          }
        }
      } else {
        throw new InvalidOperationException("Target window no longer exists before paste.");
      }
    }

    INPUT[] inputs = new INPUT[4];
    inputs[0].type = INPUT_KEYBOARD; inputs[0].U.ki.wVk = VK_CONTROL;
    inputs[1].type = INPUT_KEYBOARD; inputs[1].U.ki.wVk = VK_V;
    inputs[2].type = INPUT_KEYBOARD; inputs[2].U.ki.wVk = VK_V; inputs[2].U.ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD; inputs[3].U.ki.wVk = VK_CONTROL; inputs[3].U.ki.dwFlags = KEYEVENTF_KEYUP;
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
"@
[NativePaste]::Paste($TargetWindowHandle)
`.trimStart();
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
  const [text, items] = await Promise.all([clipboard.readText(), clipboard.read()]);
  const formats = [...new Set(items.flatMap((item) => item.types))].sort();
  return {
    text,
    signature: JSON.stringify({ text, formats }),
  };
}

export function getForegroundWindowHandle(): Promise<number | null> {
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
  targetWindowHandle?: number | null
): Promise<void> {
  const hasTargetWindow = Number.isFinite(targetWindowHandle) && Number(targetWindowHandle) > 0;

  if (method === 'sendinput') {
    const script = ensureSendInputScript();
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            '-TargetWindowHandle',
            String(targetWindowHandle ?? 0),
          ],
          {
            windowsHide: true,
            timeout: PASTE_PROCESS_TIMEOUT_MS,
          },
          (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          }
        );
      });
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
    execFile('cscript', ['//NoLogo', '//B', script], (error) => {
      if (error) {
        log.error('Failed to simulate paste', { error });
        reject(error);
      } else {
        resolve();
      }
    });
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

async function beginPasteOperation(): Promise<{ sequence: PasteSequence | null; baselineText: string }> {
  const snapshot = await readClipboardSnapshot();
  const currentSequence = activePasteSequence;

  if (currentSequence) {
    if (currentSequence.ownedSignature === snapshot.signature) {
      if (currentSequence.restoreTimer) {
        clearTimeout(currentSequence.restoreTimer);
        currentSequence.restoreTimer = null;
      }
      return { sequence: currentSequence, baselineText: currentSequence.baselineText };
    }
    discardPasteSequence(currentSequence);
  }

  return {
    sequence: null,
    baselineText: snapshot.text,
  };
}

function activatePasteSequence(
  baselineText: string,
  ownedSignature: string
): PasteSequence {
  const sequence: PasteSequence = {
    baselineText,
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

        await clipboard.writeText(sequence.baselineText);
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
  let baselineText = '';

  return enqueuePasteCriticalSection(async () => {
    let clipboardOwnershipSignature: string | null = null;
    try {
      if (pasteGeneration !== latestPasteGeneration) return;
      const operation = await beginPasteOperation();
      if (pasteGeneration !== latestPasteGeneration) return;
      sequence = operation.sequence;
      baselineText = operation.baselineText;

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
      if (!sequence) {
        sequence = activatePasteSequence(baselineText, clipboardOwnershipSignature);
      } else if (sequence && activePasteSequence === sequence) {
        sequence.ownedSignature = clipboardOwnershipSignature;
      }

      if (pasteGeneration !== latestPasteGeneration) return;
      await delay(PASTE_FOCUS_SETTLE_DELAY_MS);
      if (pasteGeneration !== latestPasteGeneration) return;
      const currentSnapshot = await readClipboardSnapshot();
      if (pasteGeneration !== latestPasteGeneration) return;
      if (currentSnapshot.signature !== clipboardOwnershipSignature) {
        if (sequence && activePasteSequence === sequence) {
          discardPasteSequence(sequence);
        }
        return;
      }
      if (pasteGeneration !== latestPasteGeneration) return;
      await simulatePaste(options.method, options.targetWindowHandle);
    } finally {
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
