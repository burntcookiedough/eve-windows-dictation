import '../app.css';
import { mount } from 'svelte';
import { toastState } from '$lib/toast.svelte';
import type { HistoryEntryWithGroup, HistoryExportRequest, HistoryFilters } from '$shared/types';
import HistoryView from '../views/HistoryView.svelte';

let entries: HistoryEntryWithGroup[] = [
  {
    id: 'fixture-1',
    timestamp: new Date(2026, 8, 19, 9, 30).getTime(),
    text: 'Plan the next Eve release and verify the export workflow.',
    audioDuration: 8.4,
    confidence: 0.96,
    transcriptionTime: 720,
    wordCount: 10,
    sessionMode: 'quick',
    editedAt: new Date(2026, 8, 19, 9, 35).getTime(),
    originalText: 'Plan the Eve release and verify the export workflow.',
    engine: 'whisper',
    model: 'large-v3-turbo',
    dateGroup: 'Today',
  },
  {
    id: 'fixture-2',
    timestamp: new Date(2026, 8, 19, 9, 29).getTime(),
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

const historyExportRequests: HistoryExportRequest[] = [];
const historyFixtureCalls = {
  historyRequests: [] as Array<HistoryFilters | undefined>,
  idRequests: [] as Array<{ filters: HistoryFilters | undefined; ids: string[] }>,
  copyRequests: [] as string[],
  rejectNextCopy: false,
  singleDeleteRequests: [] as string[],
  bulkDeleteRequests: [] as string[][],
};

function matchingEntries(filters?: HistoryFilters): HistoryEntryWithGroup[] {
  const query = filters?.text?.trim().toLowerCase();
  return entries.filter((entry) =>
    (!query || entry.text.toLowerCase().includes(query))
    && (!filters?.sessionMode || entry.sessionMode === filters.sessionMode)
    && (filters?.dateFrom === undefined || entry.timestamp >= filters.dateFrom)
    && (filters?.dateTo === undefined || entry.timestamp <= filters.dateTo)
    && (filters?.minDuration === undefined || entry.audioDuration >= filters.minDuration)
    && (filters?.maxDuration === undefined || entry.audioDuration <= filters.maxDuration)
    && (filters?.minConfidence === undefined || entry.confidence >= filters.minConfidence)
    && (!filters?.editedOnly || entry.editedAt !== undefined),
  );
}

function removeEntries(ids: string[]): string[] {
  const existingIds = new Set(entries.map(({ id }) => id));
  const deletedIds = [...new Set(ids)].filter((id) => existingIds.has(id));
  entries = entries.filter((entry) => !deletedIds.includes(entry.id));
  return deletedIds;
}

Object.assign(window, {
  historyExportRequests,
  historyFixtureCalls,
  historyToastState: () => toastState.toasts.map(({ message, type }) => ({ message, type })),
  murmurMain: {
    getHistoryEntries: async (offset: number, limit: number, filters?: HistoryFilters) => {
      historyFixtureCalls.historyRequests.push(filters ? { ...filters } : undefined);
      const matching = matchingEntries(filters);
      return { entries: matching.slice(offset, offset + limit), hasMore: offset + limit < matching.length };
    },
    getHistoryEntryIds: async (filters?: HistoryFilters) => {
      const ids = matchingEntries(filters).map(({ id }) => id);
      historyFixtureCalls.idRequests.push({ filters: filters ? { ...filters } : undefined, ids });
      return ids;
    },
    exportHistory: async (request: HistoryExportRequest) => {
      historyExportRequests.push(request);
      const requestedCount = request.scope === 'selected'
        ? request.ids?.filter((id) => entries.some((entry) => entry.id === id)).length ?? 0
        : entries.length;
      return { status: 'saved', requestedCount, exportedCount: requestedCount, missingCount: 0 };
    },
    deleteHistoryEntry: async (id: string) => {
      historyFixtureCalls.singleDeleteRequests.push(id);
      removeEntries([id]);
    },
    deleteHistoryEntries: async (ids: string[]) => {
      historyFixtureCalls.bulkDeleteRequests.push([...ids]);
      const deletedIds = removeEntries(ids);
      return {
        requestedCount: new Set(ids).size,
        deletedCount: deletedIds.length,
        deletedIds,
        missingIds: [...new Set(ids)].filter((id) => !deletedIds.includes(id)),
      };
    },
    copyToClipboard: async (text: string) => {
      historyFixtureCalls.copyRequests.push(text);
      if (historyFixtureCalls.rejectNextCopy) {
        historyFixtureCalls.rejectNextCopy = false;
        throw new Error('Synthetic clipboard failure');
      }
    },
    onNewHistoryEntry: () => () => {},
  },
});

mount(HistoryView, {
  target: document.getElementById('fixture-root')!,
});
