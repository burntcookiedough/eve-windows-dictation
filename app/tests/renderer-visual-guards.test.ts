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
const eveDropdown = readFileSync(
  new URL('../src/renderer/app/components/EveDropdown.svelte', import.meta.url),
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
const modelProgressCard = readFileSync(
  new URL('../src/renderer/app/components/ModelProgressCard.svelte', import.meta.url),
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
    expect(insightsView).toContain('Daily dictation time');
    expect(insightsView).toContain('Dictations');
    expect(insightsView).toContain('Average dictation length');
    expect(insightsView).toContain('Daily totals');
    expect(insightsView).toContain('dailyChart.unitLabel');
    expect(insightsView).toContain('@render DailyDictationChart(dailyChart, selectedRangeLabel)');
    expect(insightsView).toContain('data-insights-chart-x-axis');
    expect(insightsView).toContain('chart.xAxisStartLabel');
    expect(insightsView).toContain('chart.xAxisEndLabel');
    expect(insightsView).toContain('period ${periodLabel}; ${chart.xAxisDescription}; zero baseline; maximum scale');
    expect(insightsView).toContain('MiniLine(insights.trends)');
    expect(insightsView).toContain('formatDuration(averages[index])');
    expect(insightsView).toContain('dailyChart.bars.slice(-7)');
    expect(insightsView).toContain('<EveDropdown');
    expect(eveDropdown).toContain('role="combobox"');
    expect(eveDropdown).toContain('aria-haspopup="listbox"');
    expect(eveDropdown).toContain('role="listbox"');
    expect(eveDropdown).toContain('role="option"');
    expect(eveDropdown).toMatch(/role="option"\s+tabindex="-1"/);
    expect(eveDropdown).toContain("event.key === 'Escape'");
    expect(eveDropdown).toContain("event.key === 'ArrowDown'");
    expect(eveDropdown).toContain("event.key === 'ArrowUp'");
    expect(eveDropdown).toContain("event.key === 'Home' || event.key === 'End'");
    expect(eveDropdown).toContain('document.addEventListener(\'pointerdown\'');
    expect(eveDropdown).toContain('button?.focus({ preventScroll: true })');
    expect(eveDropdown).toContain('findTypeaheadIndex');
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
    expect(rendererMain).toContain('await unmount(mountedApp);');
    expect(rendererMain).toContain('if (!rendererMounted)');
    expect(rendererMain).toContain('Eve renderer async operation rejected');
    expect(rendererMain).not.toMatch(/unhandledrejection[\s\S]{0,180}showRendererRecovery/);
    expect(rendererMain).toContain('data-renderer-recovery');
    expect(rendererMain).toContain("recovery.style.cssText = 'display:flex;height:100%");
    expect(rendererMain).toContain('Reload interface');
    expect(rendererMain).not.toContain('normalized.message');
  });

  test('gives indeterminate model progress a direct accessible continuing label', () => {
    expect(modelProgressCard).toContain(
      'aria-label={`${view.title}: progress unavailable; transfer is continuing`}',
    );
    expect(modelProgressCard).not.toContain('aria-valuetext');
  });
});
