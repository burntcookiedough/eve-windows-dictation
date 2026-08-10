import type {
  InsightSourceEntry,
  InsightsRange,
  InsightsTrendPoint,
  InsightsWordStat,
} from './types.js';

export const INSIGHTS_RANGE_LABELS: Record<InsightsRange, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  all: 'All time',
};

export function isInsightsRange(value: unknown): value is InsightsRange {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all';
}

const STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
]);

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

export function calcWordsPerMinute(wordCount: number, audioDurationSec: number): number {
  if (!Number.isFinite(wordCount) || wordCount <= 0 || !Number.isFinite(audioDurationSec) || audioDurationSec <= 0) return 0;
  const result = wordCount / (audioDurationSec / 60);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

export function calcProcessingRatio(audioDurationSec: number, processingTimeMs: number): number {
  if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0 || !Number.isFinite(processingTimeMs) || processingTimeMs <= 0) return 0;
  const result = audioDurationSec / (processingTimeMs / 1000);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

export function tokenizeInsightWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? [])
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

export function buildPhraseStats(entries: Pick<InsightSourceEntry, 'text'>[], limit = 12): InsightsWordStat[] {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    const words = tokenizeInsightWords(entry.text);
    for (let i = 0; i < words.length - 1; i += 1) {
      const first = words[i];
      const second = words[i + 1];
      if (!first || !second) continue;
      const phrase = `${first} ${second}`;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  return sortWordStats(counts, limit);
}

export function sortWordStats(counts: Map<string, number>, limit: number): InsightsWordStat[] {
  return [...counts.entries()]
    .map(([text, count]) => ({ text, count: finiteNonNegative(count) }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, limit);
}

export function getLocalDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getLocalDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function addLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function getRangeStart(range: InsightsRange, now = Date.now()): number | null {
  const today = getLocalDayStart(now);
  switch (range) {
    case 'today':
      return today;
    case '7d':
      return addLocalDays(today, -6);
    case '30d':
      return addLocalDays(today, -29);
    case 'all':
      return null;
    default:
      return null;
  }
}

export function formatTrendLabel(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (!year || !month || !day) return dayKey;
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function buildTrendPoints(
  entries: InsightSourceEntry[],
  range: InsightsRange,
  now = Date.now()
): InsightsTrendPoint[] {
  const buckets = new Map<string, InsightSourceEntry[]>();
  const rangeStart = getRangeStart(range, now);

  for (const entry of entries) {
    if (!Number.isFinite(entry.timestamp)) continue;
    if (rangeStart !== null && entry.timestamp < rangeStart) continue;
    const key = getLocalDayKey(entry.timestamp);
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }

  if (range !== 'all') {
    const start = getRangeStart(range, now) ?? getLocalDayStart(now);
    const days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
    for (let i = 0; i < days; i += 1) {
      const key = getLocalDayKey(addLocalDays(start, i));
      if (!buckets.has(key)) buckets.set(key, []);
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => {
      const dictations = bucket.length;
      const words = bucket.reduce((sum, item) => saturatingAdd(sum, finiteNonNegative(item.wordCount ?? countWords(item.text))), 0);
      const audioSeconds = bucket.reduce((sum, item) => saturatingAdd(sum, finiteNonNegative(item.audioDuration)), 0);
      const processingMs = bucket.reduce((sum, item) => saturatingAdd(sum, finiteNonNegative(item.transcriptionTime)), 0);
      const confidenceEntries = bucket.filter((item) => Number.isFinite(item.confidence) && item.confidence >= 0);
      const avgConfidence = confidenceEntries.length
        ? Math.min(1, saturatingAddMany(confidenceEntries.map((item) => finiteNonNegative(item.confidence))) / confidenceEntries.length)
        : 0;

      return {
        date,
        label: formatTrendLabel(date),
        dictations,
        words,
        audioSeconds,
        processingMs,
        avgWpm: calcWordsPerMinute(words, audioSeconds),
        avgConfidence,
        avgProcessingRatio: calcProcessingRatio(audioSeconds, processingMs),
      };
    });
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function saturatingAdd(first: number, second: number): number {
  const sum = first + second;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function saturatingAddMany(values: number[]): number {
  return values.reduce((sum, value) => saturatingAdd(sum, value), 0);
}
