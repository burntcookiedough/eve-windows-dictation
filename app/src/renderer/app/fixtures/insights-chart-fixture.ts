import '../app.css';
import { mount } from 'svelte';
import type { InsightsResponse, InsightsTrendPoint } from '$shared/types';
import InsightsView from '../views/InsightsView.svelte';

const now = Date.now();
const today = new Date(now);
const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const trend: InsightsTrendPoint = {
  date,
  label: today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  dictations: 1,
  words: 12,
  audioSeconds: 8,
  processingMs: 600,
  avgWpm: 90,
  avgConfidence: 0.92,
  avgProcessingRatio: 13.3,
};
const insights: InsightsResponse = {
  range: '30d',
  generatedAt: now,
  hasData: true,
  indexing: { isIndexing: false, processedEntries: 1, totalEntries: 1 },
  summary: {
    totalDictations: 1,
    totalWords: 12,
    totalAudioSeconds: 8,
    totalProcessingMs: 600,
    avgConfidence: 0.92,
    avgWpm: 90,
    avgProcessingRatio: 13.3,
    avgWordsPerDictation: 12,
    longestStreakDays: 1,
    busiestDay: { date, label: trend.label, words: 12, dictations: 1 },
  },
  trends: [trend],
  commonWords: [],
  commonPhrases: [],
  longestEntries: [],
  slowestEntries: [],
  yearActivity: [{ date, words: 12, dictations: 1 }],
  hourlyDictations: Array.from({ length: 24 }, (_, hour) => hour === today.getHours() ? 1 : 0),
  previousPeriodWords: 0,
};
const indexingInsights: InsightsResponse = {
  ...insights,
  indexing: { isIndexing: true, processedEntries: 1, totalEntries: 2 },
};
let insightsRequestCount = 0;

Object.assign(window, {
  getInsightsRequestCount: () => insightsRequestCount,
  murmurMain: {
    getInsights: async () => {
      insightsRequestCount += 1;
      return insightsRequestCount === 1 ? indexingInsights : insights;
    },
    onNewHistoryEntry: () => () => {},
  },
});

mount(InsightsView, { target: document.getElementById('fixture-root')! });
