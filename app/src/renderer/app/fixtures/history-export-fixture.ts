import '../app.css';
import { mount } from 'svelte';
import type { HistoryEntryWithGroup } from '$shared/types';
import HistoryView from '../views/HistoryView.svelte';

const timestamp = new Date(2026, 8, 19, 9, 30).getTime();
const entries: HistoryEntryWithGroup[] = [
  {
    id: 'fixture-1',
    timestamp,
    text: 'Plan the next Eve release and verify the export workflow.',
    audioDuration: 8.4,
    confidence: 0.96,
    transcriptionTime: 720,
    wordCount: 10,
    sessionMode: 'quick',
    engine: 'whisper',
    model: 'large-v3-turbo',
    dateGroup: 'Today',
  },
  {
    id: 'fixture-2',
    timestamp: timestamp - 60_000,
    text: 'Filtered selections can be exported as JSON or CSV.',
    audioDuration: 6.2,
    confidence: 0.93,
    transcriptionTime: 610,
    wordCount: 9,
    sessionMode: 'long',
    engine: 'whisper',
    model: 'large-v3-turbo',
    dateGroup: 'Today',
  },
];

Object.assign(window, {
  murmurMain: {
    getHistoryEntries: async () => ({ entries, hasMore: false }),
    getHistoryEntryIds: async () => entries.map(({ id }) => id),
    exportHistory: async () => ({
      status: 'saved',
      requestedCount: entries.length,
      exportedCount: entries.length,
      missingCount: 0,
    }),
    deleteHistoryEntry: async () => {},
    deleteHistoryEntries: async () => ({
      requestedCount: 0,
      deletedCount: 0,
      deletedIds: [],
      missingIds: [],
    }),
    copyToClipboard: () => {},
    onNewHistoryEntry: () => () => {},
  },
});

mount(HistoryView, {
  target: document.getElementById('fixture-root')!,
});
