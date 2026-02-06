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

function ensurePasteScript(): string {
  if (pasteScriptPath) return pasteScriptPath;
  pasteScriptPath = join(app.getPath('userData'), 'paste-helper.vbs');
  if (!existsSync(pasteScriptPath)) {
    writeFileSync(pasteScriptPath, 'CreateObject("WScript.Shell").SendKeys "^v"\n');
    log.debug('Created paste helper script', { path: pasteScriptPath });
  }
  return pasteScriptPath;
}

export function copyToClipboard(text: string): void {
  log.debug('Writing text', { text });
  clipboard.writeText(text);
}

export function readFromClipboard(): string {
  return clipboard.readText();
}

export async function simulatePaste(): Promise<void> {
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
