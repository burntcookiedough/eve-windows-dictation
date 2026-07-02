import { describe, expect, test } from 'bun:test';
import {
  buildPhraseStats,
  buildTrendPoints,
  calcProcessingRatio,
  calcWordsPerMinute,
  countWords,
  getLocalDayKey,
  getRangeStart,
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
});
