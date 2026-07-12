import { describe, expect, test } from 'bun:test';
import {
  addLocalDays,
  buildPhraseStats,
  buildTrendPoints,
  calcProcessingRatio,
  calcWordsPerMinute,
  countWords,
  getLocalDayKey,
  getRangeStart,
  isInsightsRange,
  tokenizeInsightWords,
} from '../src/shared/insights.js';
import type { InsightSourceEntry } from '../src/shared/types.js';

function entry(
  id: string,
  timestamp: number,
  text: string,
  audioDuration: number,
  transcriptionTime: number,
  confidence = 0.9
): InsightSourceEntry {
  return {
    id,
    timestamp,
    text,
    audioDuration,
    transcriptionTime,
    confidence,
    wordCount: countWords(text),
  };
}

describe('insights helpers', () => {
  test('accepts only supported IPC range values', () => {
    expect(isInsightsRange('today')).toBe(true);
    expect(isInsightsRange('7d')).toBe(true);
    expect(isInsightsRange('30d')).toBe(true);
    expect(isInsightsRange('all')).toBe(true);
    expect(isInsightsRange('week')).toBe(false);
    expect(isInsightsRange(null)).toBe(false);
    expect(isInsightsRange({ range: '7d' })).toBe(false);
  });

  test('counts words from trimmed whitespace-separated text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   one   two\nthree  ')).toBe(3);
  });

  test('calculates weighted speaking and processing performance metrics', () => {
    expect(calcWordsPerMinute(120, 60)).toBe(120);
    expect(calcWordsPerMinute(10, 0)).toBe(0);
    expect(calcProcessingRatio(30, 15000)).toBe(2);
    expect(calcProcessingRatio(30, 0)).toBe(0);
  });

  test('tokenizes common words with stop-word filtering', () => {
    expect(tokenizeInsightWords('The quick, quick dictation for the project.')).toEqual([
      'quick',
      'quick',
      'dictation',
      'project',
    ]);
  });

  test('builds common short phrases after stop-word filtering', () => {
    const phrases = buildPhraseStats([
      { text: 'quick dictation project quick dictation' },
      { text: 'quick dictation workflow' },
    ]);

    expect(phrases[0]).toEqual({ text: 'quick dictation', count: 3 });
  });

  test('groups trend points into local day buckets and fills fixed ranges', () => {
    const now = new Date(2026, 6, 1, 12).getTime();
    const yesterday = new Date(2026, 5, 30, 9).getTime();
    const today = new Date(2026, 6, 1, 8).getTime();

    const trends = buildTrendPoints(
      [
        entry('a', yesterday, 'yesterday words', 30, 10000),
        entry('b', today, 'today has four words', 60, 30000),
      ],
      '7d',
      now
    );

    expect(trends).toHaveLength(7);
    expect(trends.at(-1)?.date).toBe(getLocalDayKey(now));
    expect(trends.at(-1)?.words).toBe(4);
    expect(trends.find((point) => point.date === getLocalDayKey(yesterday))?.dictations).toBe(1);
  });

  test('uses local midnight for range starts', () => {
    const now = new Date(2026, 6, 1, 17, 30).getTime();
    expect(getRangeStart('today', now)).toBe(new Date(2026, 6, 1).getTime());
    expect(getRangeStart('7d', now)).toBe(new Date(2026, 5, 25).getTime());
    expect(getRangeStart('all', now)).toBeNull();
  });

  test('uses calendar days across daylight-saving transitions', () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = 'America/New_York';

    try {
      const springForward = new Date(2026, 2, 8).getTime();
      const nextDay = addLocalDays(springForward, 1);
      expect(getLocalDayKey(nextDay)).toBe('2026-03-09');
      expect(nextDay - springForward).toBe(23 * 60 * 60 * 1000);

      const now = new Date(2026, 2, 10, 12).getTime();
      expect(getLocalDayKey(getRangeStart('7d', now)!)).toBe('2026-03-04');
      expect(buildTrendPoints([], '7d', now).map(({ date }) => date)).toEqual([
        '2026-03-04',
        '2026-03-05',
        '2026-03-06',
        '2026-03-07',
        '2026-03-08',
        '2026-03-09',
        '2026-03-10',
      ]);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

});
