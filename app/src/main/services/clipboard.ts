import { clipboard } from 'electron';
import { keyboard, Key } from '@nut-tree-fork/nut-js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Clipboard');

export function copyToClipboard(text: string): void {
  log.debug('Writing text', { text });
  clipboard.writeText(text);
}

export function readFromClipboard(): string {
  return clipboard.readText();
}

export async function simulatePaste(): Promise<void> {
  try {
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
  } catch (error) {
    log.error('Failed to simulate paste', { error: error as Error });
    throw error;
  }
}
