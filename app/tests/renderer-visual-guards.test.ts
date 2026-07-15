import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const historyView = readFileSync(
  new URL('../src/renderer/app/views/HistoryView.svelte', import.meta.url),
  'utf8'
);
const overlayView = readFileSync(
  new URL('../src/renderer/overlay/App.svelte', import.meta.url),
  'utf8'
);

describe('renderer visual regression guards', () => {
  test('contains long unbroken history text inside its card', () => {
    expect(historyView).toContain('group min-w-0 overflow-hidden rounded-2xl');
    expect(historyView).toContain('[overflow-wrap:anywhere]');
  });

  test('uses an accessible dark microphone warning instead of the amber card', () => {
    expect(overlayView).toContain('border-zinc-500/25 bg-black/95');
    expect(overlayView).toContain('aria-live="polite"');
    expect(overlayView).toContain('bg-red-400/35');
    expect(overlayView).toContain('motion-reduce:animate-none');
    expect(overlayView).not.toContain('border-amber-500/40 bg-amber-500/10');
  });
});
