import '../app.css';
import { mount } from 'svelte';
import { DEFAULT_SETTINGS, type InsightsResponse, type RecordingStatePayload, type ServerStatePayload } from '$shared/types';
import HomeView from '../views/HomeView.svelte';
import { serverStatusState, type ServerStatusPhase } from '../server-status';

const params = new URLSearchParams(location.search);
const phase = (params.get('phase') ?? 'ready') as ServerStatusPhase;

const readyState: ServerStatePayload = {
  status: 'running',
  managed: true,
  port: 51717,
  engineStatus: {
    current: 'whisper',
    status: 'ready',
    info: {
      id: 'whisper',
      name: 'Faster-Whisper',
      model: 'large-v3-turbo',
      supports_hotwords: true,
      languages: ['en', 'de', 'fr', 'es', 'it', 'ja'],
      model_size_gb: 1.5,
      device: 'auto',
    },
  },
  modelDownload: { model: 'large-v3-turbo', size_gb: 1.5, status: 'ready', phase: 'ready', cached: true },
};

const state: ServerStatePayload | null = phase === 'ready'
  ? readyState
  : phase === 'downloading'
    ? {
        ...readyState,
        engineStatus: { current: 'whisper', status: 'loading' },
        modelDownload: {
          model: 'large-v3',
          size_gb: 2.9,
          status: 'downloading',
          phase: 'downloading',
          progress_percent: 48,
          downloaded_bytes: 1_400_000_000,
          total_bytes: 2_900_000_000,
        },
      }
    : phase === 'error'
      ? { status: 'error', managed: true, error: 'Fixture speech service unavailable.' }
      : null;

const emptyInsights: InsightsResponse = {
  range: 'today',
  generatedAt: Date.now(),
  hasData: false,
  indexing: { isIndexing: false, processedEntries: 0, totalEntries: 0 },
  summary: {
    totalDictations: 0,
    totalWords: 0,
    totalAudioSeconds: 0,
    totalProcessingMs: 0,
    avgConfidence: 0,
    avgWpm: 0,
    avgProcessingRatio: 0,
    avgWordsPerDictation: 0,
    longestStreakDays: 0,
  },
  trends: [],
  commonWords: [],
  commonPhrases: [],
  longestEntries: [],
  slowestEntries: [],
  yearActivity: [],
  currentStreakDays: 0,
};
let insightCalls = 0;

const idleRecording: RecordingStatePayload = { state: 'idle', isRecording: false };
const unsubscribe = () => () => {};

serverStatusState.set({
  state,
  phase,
  announcement: `Fixture ${phase}`,
});

Object.assign(window, {
  getHomeInsightsCalls: () => insightCalls,
  murmurMain: {
    getSettings: async () => DEFAULT_SETTINGS,
    getHotkeyDisplayName: async (hotkey: { shiftKey: boolean }) => hotkey.shiftKey ? 'Ctrl+Shift+Win' : 'Ctrl+Win',
    getInsights: async () => {
      insightCalls += 1;
      if (params.get('indexing') !== '1') return emptyInsights;
      return {
        ...emptyInsights,
        hasData: true,
        summary: { ...emptyInsights.summary, totalWords: 123, totalDictations: 1 },
        indexing: { isIndexing: insightCalls === 1, processedEntries: insightCalls === 1 ? 0 : 1, totalEntries: 1 },
        currentStreakDays: insightCalls === 1 ? undefined : 400,
      };
    },
    getHistoryEntries: async () => ({ entries: [], hasMore: false }),
    getRecordingDebugState: async () => ({ recording: idleRecording }),
    onRecordingState: unsubscribe,
    onAudioLevel: unsubscribe,
    onNewHistoryEntry: unsubscribe,
    onSettingsChanged: unsubscribe,
  },
});

mount(HomeView, {
  target: document.getElementById('fixture-root')!,
  props: { onNavigate: () => {} },
});
