import { clipboard } from 'electron';

export function copyToClipboard(text: string): void {
  clipboard.writeText(text);
}

export function readFromClipboard(): string {
  return clipboard.readText();
}
