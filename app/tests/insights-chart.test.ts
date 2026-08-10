import { describe, expect, test } from 'bun:test';
import {
  buildDictationTimeChart,
  formatChartDuration,
  formatInsightsDuration,
} from '../src/renderer/app/insights-chart.js';
import type { InsightsTrendPoint } from '../src/shared/types.js';

function point(date: string, audioSeconds: number, dictations = 1): InsightsTrendPoint {
  return {
    date,
    label: date,
    dictations,
    words: 0,
    audioSeconds,
    processingMs: 0,
    avgWpm: 0,
    avgConfidence: 0,
    avgProcessingRatio: 0,
  };
}

function expectFiniteGeometry(chart: ReturnType<typeof buildDictationTimeChart>): void {
  expect(Number.isFinite(chart.scaleMaxSeconds)).toBe(true);
  expect(Number.isFinite(chart.totalSeconds)).toBe(true);
  expect(Number.isFinite(chart.zeroY)).toBe(true);
  for (const tick of chart.ticks) {
    expect(Number.isFinite(tick.valueSeconds)).toBe(true);
    expect(Number.isFinite(tick.y)).toBe(true);
    expect(tick.y).toBeGreaterThanOrEqual(0);
    expect(tick.y).toBeLessThanOrEqual(chart.height);
  }
  for (const bar of chart.bars) {
    for (const value of [bar.x, bar.y, bar.width, bar.height, bar.relativeWidth, bar.valueSeconds]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(bar.x).toBeLessThanOrEqual(chart.width);
    expect(bar.y).toBeLessThanOrEqual(chart.height);
    expect(bar.x + bar.width).toBeLessThanOrEqual(chart.width);
    expect(bar.y + bar.height).toBeLessThanOrEqual(chart.height);
  }
}

describe('deterministic Insights dictation-time chart', () => {
  test('uses an honest zero baseline for empty and all-zero data', () => {
    const empty = buildDictationTimeChart([]);
    expect(empty.bars).toEqual([]);
    expect(empty.scaleMaxSeconds).toBe(1);
    expect(empty.xAxisStartLabel).toBe('No recorded days');
    expect(empty.xAxisEndLabel).toBeNull();
    expect(empty.ticks.map((tick) => tick.label)).toEqual(['0s', '0.5s', '1s']);

    const zero = buildDictationTimeChart([
      point('2026-07-01', 0),
      point('2026-07-02', 0),
    ]);
    expect(zero.bars.map((bar) => bar.height)).toEqual([0, 0]);
    expect(zero.bars.map((bar) => bar.relativeWidth)).toEqual([0, 0]);
    expectFiniteGeometry(zero);
  });

  test('sorts buckets chronologically and leaves sparse days as visible gaps', () => {
    const chart = buildDictationTimeChart([
      point('2026-07-03', 120),
      point('2026-07-01', 0),
    ]);

    expect(chart.bars.map((bar) => bar.date)).toEqual(['2026-07-01', '2026-07-03']);
    expect(chart.bars.map((bar) => bar.gapBeforeDays)).toEqual([0, 1]);
    expect(chart.gapDays).toBe(1);
    expect(chart.bars[0]?.x).toBeLessThan(chart.bars[1]?.x ?? 0);
    expect(chart.bars[0]?.height).toBe(0);
    expect(chart.bars[1]?.height).toBeGreaterThan(0);
    expectFiniteGeometry(chart);
  });

  test('keeps one and identical values deterministic', () => {
    const one = buildDictationTimeChart([point('2026-07-01', 60)]);
    expect(one.xAxisStartLabel).toBe('Jul 1');
    expect(one.xAxisEndLabel).toBeNull();
    expect(one.xAxisDescription).toBe('one local day: Jul 1');

    const chart = buildDictationTimeChart([
      point('2026-07-02', 60),
      point('2026-07-01', 60),
      point('2026-07-01', 0),
    ]);

    expect(chart.bars.map((bar) => bar.valueSeconds)).toEqual([60, 60]);
    expect(chart.bars[0]?.height).toBe(chart.bars[1]?.height);
    expect(chart.totalSeconds).toBe(120);
    expect(formatChartDuration(60)).toBe('1m');
  });

  test('discards calendar-invalid dates without changing valid geometry', () => {
    const valid = [point('2026-07-01', 30), point('2026-07-03', 90)];
    const baseline = buildDictationTimeChart(valid);
    const chart = buildDictationTimeChart([
      ...valid,
      point('2026-02-31', 10),
      point('2026-13-01', 20),
      point('2026-00-15', 30),
    ]);

    expect(chart.bars).toEqual(baseline.bars);
    expect(chart.gapDays).toBe(baseline.gapDays);
    expect(chart.scaleMaxSeconds).toBe(baseline.scaleMaxSeconds);
  });

  test('sanitizes malformed and very large values with bounded labels and geometry', () => {
    const chart = buildDictationTimeChart([
      point('2026-07-01', Number.NaN),
      point('2026-07-02', Number.POSITIVE_INFINITY),
      point('2026-07-03', -10),
      point('2026-07-04', Number.MAX_VALUE),
    ]);

    expect(chart.bars.slice(0, 3).map((bar) => bar.valueSeconds)).toEqual([0, 0, 0]);
    expect(chart.bars[3]?.valueSeconds).toBe(Number.MAX_VALUE);
    expectFiniteGeometry(chart);
    expect(formatChartDuration(Number.NaN)).toBe('0s');
    expect(formatChartDuration(Number.POSITIVE_INFINITY)).toBe('0s');
    for (const label of [formatChartDuration(Number.MAX_VALUE), formatInsightsDuration(Number.MAX_VALUE)]) {
      expect(label).toBe('1.80e+308s');
      expect(label.length).toBeLessThanOrEqual(12);
    }
  });

  test('contains bars and ticks inside a collapsed custom viewBox', () => {
    const chart = buildDictationTimeChart([
      point('2026-07-01', 1),
      point('2026-07-02', 2),
    ], 1, 1);

    expect(chart.width).toBe(1);
    expect(chart.height).toBe(1);
    expectFiniteGeometry(chart);
  });
});
