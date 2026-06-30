import { clipboard } from 'electron';
import { execFile } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Clipboard');

// VBScript for keyboard simulation — much faster startup than PowerShell (~50ms vs ~300ms).
// Written to userData once and reused via cscript.
let pasteScriptPath: string | null = null;
let sendInputScriptPath: string | null = null;

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
  if (!existsSync(sendInputScriptPath)) {
    writeFileSync(
      sendInputScriptPath,
      `
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
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const ushort VK_CONTROL = 0x11;
  public const ushort VK_V = 0x56;

  public static void Paste() {
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
[NativePaste]::Paste()
`.trimStart(),
      'utf8'
    );
    log.debug('Created SendInput paste helper script', { path: sendInputScriptPath });
  }
  return sendInputScriptPath;
}

export function copyToClipboard(text: string): void {
  log.debug('Writing text', { text });
  clipboard.writeText(text);
}

export function readFromClipboard(): string {
  return clipboard.readText();
}

export async function simulatePaste(method: 'sendinput' | 'vbscript' = 'sendinput'): Promise<void> {
  if (method === 'sendinput') {
    const script = ensureSendInputScript();
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
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
      log.error('SendInput paste failed; falling back to VBScript', { error: error as Error });
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
  restoreClipboard: boolean;
  restoreDelayMs: number;
  method: 'sendinput' | 'vbscript';
}

export async function pasteText(text: string, options: PasteTextOptions): Promise<void> {
  const previous = clipboard.readText();
  clipboard.writeText(text);
  try {
    await simulatePaste(options.method);
  } finally {
    if (options.restoreClipboard) {
      setTimeout(() => {
        try {
          clipboard.writeText(previous);
        } catch (error) {
          log.error('Failed to restore clipboard', { error: error as Error });
        }
      }, Math.max(0, options.restoreDelayMs));
    }
  }
}
