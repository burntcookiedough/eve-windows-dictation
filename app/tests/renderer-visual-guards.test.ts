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
const insightsView = readFileSync(
  new URL('../src/renderer/app/views/InsightsView.svelte', import.meta.url),
  'utf8'
);
const settingsSection = readFileSync(
  new URL('../src/renderer/app/components/SettingsSection.svelte', import.meta.url),
  'utf8'
);
const rendererMain = readFileSync(
  new URL('../src/renderer/app/main.ts', import.meta.url),
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

    expect(warningCard).toContain('border-white/15 bg-black/95');
    expect(warningCard).not.toContain('amber');
    expect(warningIndicator).toContain('bg-red-400/35');
    expect(warningIndicator).toContain('motion-reduce:animate-none');
  });

  test('keeps the approved Insights visual hierarchy backed by real trend data', () => {
    expect(insightsView).toContain('Dictation time');
    expect(insightsView).toContain('Dictations');
    expect(insightsView).toContain('Average dictation length');
    expect(insightsView).toContain('Dictation time by day');
    expect(insightsView).toContain("MiniBars(insights.trends, 'audioSeconds')");
    expect(insightsView).toContain('MiniLine(insights.trends)');
    expect(insightsView).toContain('point.audioSeconds / point.dictations');
    expect(insightsView).toContain('formatDuration(averages[index])');
    expect(insightsView).toContain('insights.trends.slice(-7)');
    expect(insightsView).toContain('aria-haspopup="listbox"');
    expect(insightsView).toContain('aria-controls="insights-range-listbox"');
    expect(insightsView).toContain('id="insights-range-listbox"');
    expect(insightsView).toContain('role="listbox"');
    expect(insightsView).toContain('role="option"');
    expect(insightsView).toMatch(/role="option"\s+tabindex="-1"/);
    expect(insightsView).toContain("event.key === 'Escape'");
    expect(insightsView).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'");
    expect(insightsView).toContain("event.key === 'Home' || event.key === 'End'");
    expect(insightsView).toContain('onfocusout={handleRangeMenuFocusout}');
    expect(insightsView).toContain('rangeButton?.focus({ preventScroll: true })');
    expect(insightsView).toContain('onclick={() => selectRange(option.id)}');
    expect(insightsView).toMatch(/function selectRange[\s\S]*?loadInsights\(\);[\s\S]*?\n  }/);
    expect(insightsView).not.toContain('<select');
    expect(insightsView).not.toContain('gpt-4o-transcribe');
  });

  test('uses compact contiguous settings rows instead of isolated cards', () => {
    expect(settingsSection).toContain('divide-y');
    expect(settingsSection).toContain("variant === 'rows'");
    expect(settingsSection).toContain("variant === 'panel'");
    expect(settingsSection).toContain('aria-labelledby={headingId}');
    expect(settingsSection).not.toContain('overflow-hidden');
  });

  test('provides a renderer recovery surface instead of leaving a blank window', () => {
    expect(rendererMain).toContain("window.addEventListener('error'");
    expect(rendererMain).toContain("window.addEventListener('unhandledrejection'");
    expect(rendererMain).toContain('void unmount(app);');
    expect(rendererMain).toContain('data-renderer-recovery');
    expect(rendererMain).toContain('Reload interface');
    expect(rendererMain).not.toContain('normalized.message');
  });
});
