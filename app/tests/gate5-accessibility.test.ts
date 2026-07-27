import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const mainWindow = source('../src/main/windows/main.ts');
const overlayWindow = source('../src/main/windows/overlay.ts');
const appView = source('../src/renderer/app/App.svelte');
const appCss = source('../src/renderer/app/app.css');
const titleBar = source('../src/renderer/app/components/TitleBar.svelte');
const hotkeyModal = source('../src/renderer/app/components/HotkeyCaptureModal.svelte');
const toggle = source('../src/renderer/app/components/Toggle.svelte');
const overlayView = source('../src/renderer/overlay/App.svelte');
const overlayText = source('../src/renderer/overlay/components/TextDisplay.svelte');
const overlayPill = source('../src/renderer/overlay/components/Pill.svelte');

describe('Gate 5 accessibility contracts', () => {
  test('uses native Windows caption controls and preserves drag regions', () => {
    expect(mainWindow).toContain("titleBarStyle: 'hidden'");
    expect(mainWindow).toContain('titleBarOverlay:');
    expect(titleBar).toContain('[-webkit-app-region:drag]');
    expect(titleBar).not.toContain('onclick={minimize}');
    expect(titleBar).not.toContain('onclick={maximize}');
    expect(titleBar).not.toContain('onclick={close}');
  });

  test('provides visible focus, forced-colors, reduced motion, and transparency fallbacks', () => {
    expect(appView).toContain('focus-visible:ring-2');
    expect(appCss).toContain('@media (forced-colors: active)');
    expect(appCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(appCss).toContain('@media (prefers-reduced-transparency: reduce)');
  });

  test('keeps switch semantics and a minimum target', () => {
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain('aria-checked={enabled}');
    expect(toggle).toContain('aria-label={label}');
    expect(toggle).toContain('min-w-10');
    expect(toggle).toContain('min-h-6');
  });

  test('traps modal focus, supports Escape, and restores the opener', () => {
    expect(hotkeyModal).toContain("e.key === 'Tab'");
    expect(hotkeyModal).toContain("e.key === 'Escape'");
    expect(hotkeyModal).toContain('returnFocus?.focus()');
    expect(hotkeyModal).toContain('aria-modal="true"');
  });

  test('keeps the overlay click-through, non-focusable, and noninteractive', () => {
    expect(overlayWindow).toContain('focusable: false');
    expect(overlayWindow).toContain('overlay.setIgnoreMouseEvents(true)');
    expect(overlayView).toContain('aria-hidden="true"');
    expect(overlayView).not.toMatch(/<button|tabindex=|on(?:click|pointer|mouse)/);
  });

  test('uses fixed two-line auto-follow without an operable scrollbar or glow', () => {
    expect(overlayText).toContain('scrollTop = scrollRef!.scrollHeight');
    expect(overlayText).toContain('h-16');
    expect(overlayText).toContain('line-clamp-2');
    expect(overlayText).toContain('overflow-hidden');
    expect(overlayText).not.toContain('overflow-y-auto');
    expect(overlayPill).not.toContain('shadow-[');
  });
});
