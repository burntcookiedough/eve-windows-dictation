import type { InsightsTrendPoint } from '../../shared/types.js';

/**
 * The primary Insights chart is daily dictation time: persisted audio seconds
 * per local calendar day over the selected period. Zero-valued fixed-range
 * days are retained, while gaps in All time remain visible as empty space.
 */
export const DICTATION_TIME_CHART_WIDTH = 240;
export const DICTATION_TIME_CHART_HEIGHT = 112;
// Past this many seconds, scientific notation keeps labels stable in narrow layouts.
export const EXTREME_DURATION_SECONDS = 1e12;

const PLOT_LEFT = 34;
const PLOT_RIGHT = 8;
const PLOT_TOP = 10;
const PLOT_BOTTOM = 82;
const MAX_BAR_WIDTH = 18;

export interface DictationTimeChartTick {
  valueSeconds: number;
  y: number;
  label: string;
}

export interface DictationTimeChartBar {
  date: string;
  label: string;
  valueSeconds: number;
  valueLabel: string;
  x: number;
  y: number;
  width: number;
  height: number;
  relativeWidth: number;
  gapBeforeDays: number;
}

export interface DictationTimeChart {
  metricLabel: 'Daily dictation time';
  unitLabel: 'seconds per local calendar day';
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  zeroY: number;
  scaleMaxSeconds: number;
  scaleLabel: string;
  totalSeconds: number;
  gapDays: number;
  xAxisStartLabel: string;
  xAxisEndLabel: string | null;
  xAxisDescription: string;
  ticks: DictationTimeChartTick[];
  bars: DictationTimeChartBar[];
}

interface NormalizedPoint {
  date: string;
  label: string;
  valueSeconds: number;
}

export function buildDictationTimeChart(
  points: InsightsTrendPoint[],
  width = DICTATION_TIME_CHART_WIDTH,
  height = DICTATION_TIME_CHART_HEIGHT,
): DictationTimeChart {
  const safeWidth = finitePositive(width, DICTATION_TIME_CHART_WIDTH);
  const safeHeight = finitePositive(height, DICTATION_TIME_CHART_HEIGHT);
  const normalized = normalizePoints(points);
  const plotLeft = clamp(PLOT_LEFT, 0, safeWidth);
  const plotRight = Math.max(plotLeft, safeWidth - Math.min(PLOT_RIGHT, safeWidth - plotLeft));
  const plotWidth = plotRight - plotLeft;
  const plotTop = clamp(PLOT_TOP, 0, safeHeight);
  const zeroY = clamp(PLOT_BOTTOM, plotTop, safeHeight);
  const plotHeight = Math.max(0, zeroY - plotTop);
  const maximum = normalized.reduce((peak, point) => Math.max(peak, point.valueSeconds), 0);
  const scaleMaxSeconds = chooseScaleMax(maximum);
  const totalSeconds = normalized.reduce((sum, point) => safeAdd(sum, point.valueSeconds), 0);
  const firstDay = normalized[0] ? dayOrdinal(normalized[0].date) ?? 0 : 0;
  const lastDay = normalized.at(-1) ? dayOrdinal(normalized.at(-1)!.date) ?? firstDay : firstDay;
  const daySpan = Math.max(1, lastDay - firstDay + 1);
  const barWidth = normalized.length > 0 && plotWidth > 0
    ? Math.min(MAX_BAR_WIDTH, (plotWidth / daySpan) * 0.7)
    : 0;

  let gapDays = 0;
  let previousDay: number | null = null;
  const bars = normalized.map((point) => {
    // normalizePoints has already discarded invalid keys; the fallback keeps the
    // geometry total if this helper is changed independently in the future.
    const currentDay = dayOrdinal(point.date) ?? firstDay;
    const gapBeforeDays = previousDay === null ? 0 : Math.max(0, currentDay - previousDay - 1);
    gapDays += gapBeforeDays;
    previousDay = currentDay;

    const center = normalized.length === 1
      ? plotLeft + plotWidth / 2
      : plotLeft + ((currentDay - firstDay) / Math.max(1, daySpan - 1)) * plotWidth;
    const x = clamp(center - barWidth / 2, plotLeft, Math.max(plotLeft, plotRight - barWidth));
    const heightValue = clamp((point.valueSeconds / scaleMaxSeconds) * plotHeight, 0, plotHeight);
    const y = clamp(zeroY - heightValue, plotTop, zeroY);

    return {
      date: point.date,
      label: point.label,
      valueSeconds: point.valueSeconds,
      valueLabel: formatChartDuration(point.valueSeconds),
      x,
      y,
      width: barWidth,
      height: heightValue,
      relativeWidth: clamp((point.valueSeconds / scaleMaxSeconds) * 100, 0, 100),
      gapBeforeDays,
    };
  });

  const ticks = [0, scaleMaxSeconds / 2, scaleMaxSeconds].map((valueSeconds) => ({
    valueSeconds,
    y: clamp(zeroY - (valueSeconds / scaleMaxSeconds) * plotHeight, plotTop, zeroY),
    label: formatChartDuration(valueSeconds),
  }));
  const xAxis = buildXAxisLabels(normalized);

  return {
    metricLabel: 'Daily dictation time',
    unitLabel: 'seconds per local calendar day',
    width: safeWidth,
    height: safeHeight,
    plotLeft,
    plotRight,
    zeroY,
    scaleMaxSeconds,
    scaleLabel: formatChartDuration(scaleMaxSeconds),
    totalSeconds,
    gapDays,
    ...xAxis,
    ticks,
    bars,
  };
}

export function formatChartDuration(seconds: number): string {
  const value = finiteNonNegative(seconds);
  if (value >= EXTREME_DURATION_SECONDS) return formatExtremeDuration(value);
  if (value === 0) return '0s';
  if (value < 60) return `${formatCompact(value)}s`;
  if (value < 3600) return `${formatCompact(value / 60)}m`;
  return `${formatCompact(value / 3600)}h`;
}

export function formatInsightsDuration(seconds: number): string {
  const value = finiteNonNegative(seconds);
  if (value >= EXTREME_DURATION_SECONDS) return formatExtremeDuration(value);
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  const remainingSeconds = Math.round(value % 60);
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function normalizePoints(points: InsightsTrendPoint[]): NormalizedPoint[] {
  const byDate = new Map<string, NormalizedPoint>();
  for (const point of points) {
    if (dayOrdinal(point.date) === null) continue;
    const current = byDate.get(point.date);
    const valueSeconds = finiteNonNegative(point.audioSeconds);
    if (current) {
      current.valueSeconds = safeAdd(current.valueSeconds, valueSeconds);
    } else {
      byDate.set(point.date, {
        date: point.date,
        label: point.label || point.date,
        valueSeconds,
      });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function chooseScaleMax(value: number): number {
  const maximum = finiteNonNegative(value);
  if (maximum === 0) return 1;

  const exponent = Math.floor(Math.log10(maximum));
  const magnitude = 10 ** exponent;
  if (!Number.isFinite(magnitude) || magnitude <= 0) return maximum;

  const normalized = maximum / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const scale = step * magnitude;
  return Number.isFinite(scale) && scale >= maximum ? scale : maximum;
}

function buildXAxisLabels(points: NormalizedPoint[]): Pick<DictationTimeChart, 'xAxisStartLabel' | 'xAxisEndLabel' | 'xAxisDescription'> {
  if (points.length === 0) {
    return {
      xAxisStartLabel: 'No recorded days',
      xAxisEndLabel: null,
      xAxisDescription: 'no recorded local days',
    };
  }

  const start = formatDayLabel(points[0]!.date);
  if (points.length === 1) {
    return {
      xAxisStartLabel: start,
      xAxisEndLabel: null,
      xAxisDescription: `one local day: ${start}`,
    };
  }

  const end = formatDayLabel(points.at(-1)!.date);
  return {
    xAxisStartLabel: start,
    xAxisEndLabel: end,
    xAxisDescription: `from ${start} through ${end}`,
  };
}

function dayOrdinal(dayKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return timestamp / 86400000;
}

function formatDayLabel(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return dayKey;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safeAdd(first: number, second: number): number {
  const sum = first + second;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= EXTREME_DURATION_SECONDS) return value.toExponential(2);
  if (value < 10) return value.toFixed(1).replace(/\.0$/, '');
  return Math.round(value).toLocaleString('en-US');
}

function formatExtremeDuration(value: number): string {
  return `${value.toExponential(2)}s`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
