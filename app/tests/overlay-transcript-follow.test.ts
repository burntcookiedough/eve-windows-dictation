import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const textDisplay = source('../src/renderer/overlay/components/TextDisplay.svelte');
const overlayApp = source('../src/renderer/overlay/App.svelte');
const overlayCss = source('../src/renderer/overlay/app.css');

describe('overlay transcript follow', () => {
  test('renders one, two, and three-or-more lines in full while showing only a two-line viewport', () => {
    expect(textDisplay).toContain('class="h-11 overflow-hidden');
    expect(textDisplay).toContain('leading-[22px]');
    expect(textDisplay).not.toContain('line-clamp-2');
    expect(textDisplay).toMatch(/<p class="[^"]+">\s*\{text\}\s*<\/p>/);
  });

  test('supports the quick and long overlay widths without changing transcript flow', () => {
    expect(textDisplay).toContain("mode === 'long' ? 'w-full max-w-[320px]' : 'w-full max-w-[280px]'");
    expect(textDisplay).toContain('break-words');
  });

  test('follows the newest line after each rendered partial update, including rapid appends', () => {
    expect(textDisplay).toContain("import { tick } from 'svelte'");
    expect(textDisplay).toContain('tick().then(() => {');
    expect(textDisplay).toContain('scrollRef.scrollTop = scrollRef.scrollHeight');
    expect(textDisplay).toContain('scrollRef.scrollHeight > scrollRef.clientHeight');
    expect(textDisplay).toContain('if (!scrollRef || !text) return;');
  });

  test('clears overflow treatment between dictation sessions', () => {
    expect(textDisplay).toContain('if (!text) {');
    expect(textDisplay).toContain('isOverflowing = false;');
    expect(overlayApp).toMatch(/transcriptionText = '';\s+transcriptionType = 'partial';/);
  });

  test('preserves noninteractive and reduced-motion accessibility protections', () => {
    expect(overlayApp).toContain('aria-hidden="true"');
    expect(overlayApp).not.toMatch(/<button|tabindex=|on(?:click|pointer|mouse)/);
    expect(overlayCss).toContain('@media (forced-colors: active)');
    expect(overlayCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(overlayCss).toContain('scroll-behavior: auto !important;');
  });
});
