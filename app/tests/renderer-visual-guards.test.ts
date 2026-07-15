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
    const historyCard = historyView.match(/<div\s+class="group[^>]+>/)?.[0];
    const transcript = historyView.match(/<p\s+class="[^"]+"[^>]*>\s*\{item\.text\}\s*<\/p>/)?.[0];

    expect(historyCard).toContain('min-w-0 overflow-hidden');
    expect(transcript).toContain('max-w-full');
    expect(transcript).toContain('[overflow-wrap:anywhere]');
  });

  test('uses an accessible dark microphone warning instead of the amber card', () => {
    const warning = overlayView.match(/\{#if warningMessage\}([\s\S]*?)\{\/if\}/)?.[1];
    const warningCard = warning?.match(/<div\s+class="[^"]+"\s+role="status"\s+aria-live="polite"\s*>/)?.[0];
    const warningIndicator = warning?.match(/<span\s+class="[^"]*animate-ping[^"]*"[^>]*>/)?.[0];

    expect(warningCard).toContain('border-zinc-500/25 bg-black/95');
    expect(warningCard).not.toContain('amber');
    expect(warningIndicator).toContain('bg-red-400/35');
    expect(warningIndicator).toContain('motion-reduce:animate-none');
  });
});
