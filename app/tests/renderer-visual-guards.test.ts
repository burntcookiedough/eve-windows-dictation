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
const modelProgressCard = readFileSync(
  new URL('../src/renderer/app/components/ModelProgressCard.svelte', import.meta.url),
  'utf8'
);

describe('renderer visual regression guards', () => {
  test('contains long unbroken history text inside the thin day-group row', () => {
    const historyEntry = historyView.match(/<article\s+class="entry"[^>]*>/)?.[0];
    const transcript = historyView.match(/<span\s+class="entry-text">[\s\S]*?<\/span>/)?.[0];

    expect(historyEntry).toContain('class="entry"');
    expect(transcript).toContain('item.text');
    expect(historyView).toContain('overflow-wrap: anywhere');
    expect(historyView).toContain('aria-hidden={!isExpanded} inert={!isExpanded}');
    expect(historyView).toContain('data-history-export-all');
    expect(historyView).toContain('data-history-selection-toggle');
    expect(historyView).toContain("import Cactus from '../components/Cactus.svelte';");
    expect(historyView).toContain('<Cactus class="empty-cactus" />');
    expect(historyView).toContain(':global(.empty-cactus) { width: 30px;');
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
    expect(insightsView).toContain("{ id: '7d', label: '7d' }");
    expect(insightsView).toContain("{ id: '30d', label: '30d' }");
    expect(insightsView).toContain("{ id: '90d', label: '90d' }");
    expect(insightsView).toContain("{ id: '1y', label: '1y' }");
    expect(insightsView).toContain("{ id: 'today', label: 'Today' }");
    expect(insightsView).toContain("{ id: 'all', label: 'All time' }");
    expect(insightsView).toContain('buildWordsAreaChart(insights?.trends ?? [], chartWidth, 160)');
    expect(insightsView).toContain('data-insights-word-chart');
    expect(insightsView).toContain('onpointermove={handleChartPointerMove}');
    expect(insightsView).toContain('onkeydown={handleChartKeydown}');
    expect(insightsView).toContain('Dictations');
    expect(insightsView).toContain('Avg length');
    expect(insightsView).toContain('dailyChart.unitLabel');
    expect(insightsView).toContain('@render DailyDictationChart(');
    expect(insightsView).toContain('class="daily-chart-axis"');
    expect(insightsView).toContain('chart.xAxisStartLabel');
    expect(insightsView).toContain('chart.xAxisEndLabel');
    expect(insightsView).toContain('${chart.xAxisDescription}; zero baseline; maximum scale');
    expect(insightsView).toContain('insights?.yearActivity');
    expect(insightsView).toContain('insights?.hourlyDictations');
    expect(insightsView).toContain('insights?.previousPeriodWords');
    expect(insightsView).toContain('insights.fastestEntry');
    expect(insightsView).toContain('insights?.hasData ? formatTypingDifference');
    expect(insightsView).toContain("insights.summary.totalDictations > 0 ? formatRatio(insights.summary.avgProcessingRatio) : '—'");
    expect(insightsView).toContain('data-r style:--r={0}');
    expect(insightsView).toContain('data-r style:--r={7}');
    expect(insightsView).toContain('More insights');
    expect(insightsView).toContain('Common phrases');
    expect(insightsView).toContain('Slowest processing');
    expect(insightsView).not.toContain('<select');
    expect(insightsView).not.toContain('gpt-4o-transcribe');
  });

  test('uses compact contiguous settings rows instead of isolated cards', () => {
    const settingsRow = readFileSync(
      new URL('../src/renderer/app/components/SettingsRow.svelte', import.meta.url),
      'utf8'
    );
    const settingsGroup = readFileSync(
      new URL('../src/renderer/app/components/SettingsGroup.svelte', import.meta.url),
      'utf8'
    );
    expect(settingsSection).toContain('margin-top: 26px;');
    expect(settingsSection).toContain('font-size: 10px;');
    expect(settingsSection).toContain('aria-labelledby={headingId}');
    expect(settingsSection).not.toContain('overflow-hidden');
    expect(settingsRow).toContain('min-height: 46px;');
    expect(settingsRow).toContain('border-top: 1px solid var(--line');
    expect(settingsGroup).toContain('<details data-settings-group');
    expect(settingsGroup).toContain('grid-template-rows: 0fr;');
    expect(settingsGroup).toContain('grid-template-rows: 1fr;');
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
