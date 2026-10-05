import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function normalized(sourceText: string): string {
  return sourceText.replace(/\s+/g, ' ').trim();
}

const historyService = source('../src/main/services/history.ts');
const handlers = source('../src/main/ipc/handlers.ts');
const preload = source('../src/main/preload/main.ts');
const rendererTypes = source('../src/renderer/global.d.ts');
const constants = source('../src/shared/constants.ts');
const types = source('../src/shared/types.ts');
const historyView = source('../src/renderer/app/views/HistoryView.svelte');
const deleteQueue = source('../src/renderer/app/history-delete-queue.svelte.ts');
const mainWindow = source('../src/main/windows/main.ts');

const deleteManyMatch = historyService.match(
  /  deleteMany\(ids: string\[\]\): HistoryDeleteResult \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  getById/
);
if (!deleteManyMatch) {
  throw new Error('HistoryService.deleteMany contract section was not found');
}
const deleteManySection = deleteManyMatch[1]!;
const historyViewFlat = normalized(historyView);
const newEntryHandlerMatch = historyView.match(
  /const unsubscribeNewHistoryEntry = window\.murmurMain\.onNewHistoryEntry\(\(entry\) => \{([\s\S]*?)\r?\n    \}\);/
);
if (!newEntryHandlerMatch) {
  throw new Error('HistoryView new-entry handler contract section was not found');
}
const newEntryHandler = normalized(newEntryHandlerMatch[1]!);
const deleteCommittedMatch = historyView.match(/function onDeleteCommitted\(event: Event\): void \{([\s\S]*?)\r?\n  \}/);
if (!deleteCommittedMatch) throw new Error('HistoryView delete-committed handler was not found');
const deleteCommittedHandler = normalized(deleteCommittedMatch[1]!);

describe('History selection and bulk deletion contracts', () => {
  test('exposes filtered IDs and one transactional bulk service operation', () => {
    expect(constants).toContain("HISTORY_GET_ENTRY_IDS: 'history:get-entry-ids'");
    expect(constants).toContain("HISTORY_DELETE_BULK: 'history:delete-bulk'");
    expect(types).toContain('export interface HistoryDeleteResult');
    expect(types).toContain('requestedCount: number');
    expect(types).toContain('missingIds: string[]');
    expect(types).toContain('requestedCount counts the deduplicated, non-empty IDs');
    expect(historyService).toContain('getEntryIds(filters?: HistoryFilters): string[]');
    expect(historyService).toContain('const { whereClause, params } = buildHistoryQuery(filters);');
    expect(historyService).toContain('const HISTORY_ID_CHUNK_SIZE = 500;');
    expect(deleteManySection).toContain('this.db.transaction');
    expect(deleteManySection).toContain('return remove.immediate(requestedIds);');
    expect(deleteManySection).toContain('DELETE FROM transcriptions WHERE id IN');
    expect(deleteManySection).toContain('getEntriesByIds(selectedIds)');
    expect(deleteManySection).toContain('removeEntriesFromInsightsWithinTransaction(existing)');
    expect(deleteManySection).toContain('missingIds');
    expect(deleteManySection).not.toContain('this.delete(');
    expect(historyService).toContain('DELETE FROM insights_word_counts WHERE day = @day AND count <= 0');
    expect(historyService).toContain('const deleteProcessed = this.db.prepare');
  });

  test('keeps IPC and preload boundaries typed, validated, and bulk-shaped', () => {
    expect(handlers).toContain('IPC_CHANNELS.HISTORY_GET_ENTRY_IDS');
    expect(handlers).toContain('isHistoryFilters(filters)');
    expect(handlers).toContain("throw new TypeError('Invalid history filters')");
    expect(handlers).toContain('historyServiceRef.getEntryIds(filters)');
    expect(handlers).toContain('IPC_CHANNELS.HISTORY_DELETE_BULK');
    expect(handlers).toContain('historyServiceRef.deleteMany(ids)');
    expect(handlers).toContain("throw new TypeError('Invalid history entry IDs')");
    expect(handlers).toContain("throw new Error('History service is unavailable; try again.')");
    expect(preload).toContain('ipcRenderer.invoke(IPC_CHANNELS.HISTORY_GET_ENTRY_IDS, filters)');
    expect(preload).toContain('ipcRenderer.invoke(IPC_CHANNELS.HISTORY_DELETE_BULK, ids)');
    expect(rendererTypes).toContain('getHistoryEntryIds: (filters?: HistoryFilters) => Promise<string[]>');
    expect(rendererTypes).toContain('deleteHistoryEntries: (ids: string[]) => Promise<HistoryDeleteResult>');
  });

  test('supports current-filter selection, exact counts, stale-result safety, and retryable deletion', () => {
    expect(historyViewFlat).toContain('let selectedIds = $state<Set<string>>(new Set());');
    expect(historyViewFlat).toContain('let selectedCount = $derived(selectedIds.size);');
    expect(historyViewFlat).toContain('const ids = await window.murmurMain.getHistoryEntryIds(buildFilters());');
    expect(historyViewFlat).toContain('const generation = ++selectionGeneration;');
    expect(historyViewFlat).toContain('if (generation !== selectionGeneration) return;');
    expect(historyViewFlat).toContain('data-history-selection-count');
    expect(historyViewFlat).toContain('aria-live="polite"');
    expect(historyViewFlat).toContain('data-history-selection-toggle');
    expect(historyViewFlat).toContain('aria-pressed={selectionMode}');
    expect(historyViewFlat).toContain('data-history-select-all');
    expect(historyViewFlat).toContain('data-history-clear-selection');
    expect(historyViewFlat).toContain('data-history-delete-selected');
    expect(historyViewFlat).toContain('const result = await window.murmurMain.deleteHistoryEntries(ids);');
    expect(historyViewFlat).toContain('result.deletedCount');
    expect(historyViewFlat).toContain('result.missingIds.length');
    expect(historyViewFlat).toContain('await loadEntries(true);');
    expect(historyViewFlat).toContain('if (bulkDeleting || exporting || !hasSelection) return;');
    expect(historyViewFlat).toContain('selectionFeedback = \'History could not be deleted. Nothing was removed. Try again.\';');
    expect(historyViewFlat).toContain('{#if selectionFeedback && !bulkDeleteConfirmOpen}');
    expect(historyViewFlat).toContain('function cancelBulkDelete(): void { exitSelectionMode(); closeBulkDeleteDialog(); }');
    expect(historyViewFlat).toContain('clearSelection(); if (searchTimeout)');
    expect(historyViewFlat).toContain('clearSelection(); loadEntries(true);');
    expect(historyViewFlat).toContain('const removedCount = history.filter((item) => deletedIds.has(item.id)).length;');
    expect(historyViewFlat).toContain('offset = Math.max(0, offset - removedCount);');
    expect(historyViewFlat).toContain('selectedIds = new Set([...selectedIds].filter((id) => !deletedIds.has(id)));');
    expect(deleteCommittedHandler).not.toContain('loadEntries(');
    expect(newEntryHandler).not.toContain('exitSelectionMode()');
  });

  test('refreshes the paged snapshot when a live entry arrives during a fetch', () => {
    expect(newEntryHandler).toContain('if (loading) { void loadEntries(true); return; }');
    expect(newEntryHandler).toContain('history = [entry, ...history]; offset += 1;');
    expect(historyView).toContain("if (historyRoot?.closest('[inert]')) return;");
    expect(historyView).toContain('flushExpiredDeferredHistoryDeletes();');
    expect(historyView).not.toContain('pauseDeferredHistoryDeletes');
    expect(historyView).not.toContain('resumeDeferredHistoryDeletes');
    expect(deleteQueue).toContain('const DELETE_DELAY_MS = 5000;');
    expect(deleteQueue).toContain('export async function flushDeferredHistoryDeletes(): Promise<void>');
    expect(historyView).toContain('class="delete-action"');
    expect(historyView).not.toContain('class="primary-action"');
    expect(mainWindow).toContain("executeJavaScript('window.__flushDeferredHistoryDeletesOnQuit?.()')");
    expect(mainWindow).toContain('quitFlushPending = true;');
    expect(mainWindow).toContain('app.quit();');
    expect(historyView).toContain("document.addEventListener('visibilitychange', handleVisibilityChange);");
  });

  test('makes row selection and confirmation keyboard/screen-reader accessible', () => {
    expect(historyViewFlat).toContain('type="checkbox"');
    expect(historyViewFlat).toContain('aria-label={`Select transcription from ${formatFullDate(item.timestamp)}`}');
    expect(historyViewFlat).toContain('<svelte:window onkeydown={handleWindowKeydown} />');
    expect(historyViewFlat).toContain("if (event.key === 'Escape')");
    expect(historyViewFlat).toContain('else if (!bulkDeleting) cancelBulkDelete();');
    expect(historyViewFlat).toContain("if (event.key === 'Tab')");
    expect(historyViewFlat).toContain('bulkDeleteTrigger = document.activeElement instanceof HTMLElement');
    expect(historyViewFlat).toContain('if (trigger?.isConnected) trigger.focus();');
    expect(historyViewFlat).toContain('else selectionToggle?.focus();');
    expect(historyViewFlat).toContain('role="dialog"');
    expect(historyViewFlat).toContain('aria-labelledby="bulk-delete-dialog-title"');
    expect(historyViewFlat).toContain('aria-describedby="bulk-delete-dialog-description"');
    expect(historyViewFlat).toContain('Exactly {selectedCount} selected');
    expect(historyViewFlat).toContain('disabled={bulkDeleting}');
    expect(historyViewFlat).toContain('aria-busy={bulkDeleting}');
  });
});
