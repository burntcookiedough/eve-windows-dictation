import { clipboard } from 'electron';
import { keyboard, Key } from '@nut-tree-fork/nut-js';

export function copyToClipboard(text: string): void {
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
    console.error('Failed to simulate paste:', error);
    throw error;
  }
}
