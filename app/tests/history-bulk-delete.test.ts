import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const historyService = source('../src/main/services/history.ts');
const handlers = source('../src/main/ipc/handlers.ts');
const preload = source('../src/main/preload/main.ts');
const rendererTypes = source('../src/renderer/global.d.ts');
const constants = source('../src/shared/constants.ts');
const types = source('../src/shared/types.ts');
const historyView = source('../src/renderer/app/views/HistoryView.svelte');

const deleteManySection = historyService.match(
  /  deleteMany\(ids: string\[\]\): HistoryDeleteResult \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  getById/
)?.[1] ?? '';

describe('History selection and bulk deletion contracts', () => {
  test('exposes filtered IDs and one transactional bulk service operation', () => {
    expect(constants).toContain("HISTORY_GET_ENTRY_IDS: 'history:get-entry-ids'");
    expect(constants).toContain("HISTORY_DELETE_BULK: 'history:delete-bulk'");
    expect(types).toContain('export interface HistoryDeleteResult');
    expect(types).toContain('requestedCount: number');
    expect(types).toContain('missingIds: string[]');
    expect(historyService).toContain('getEntryIds(filters?: HistoryFilters): string[]');
    expect(historyService).toContain('const { whereClause, params } = buildHistoryQuery(filters);');
    expect(deleteManySection).toContain('this.db.transaction');
    expect(deleteManySection).toContain('DELETE FROM transcriptions WHERE id IN');
    expect(deleteManySection).toContain('getEntriesByIds(selectedIds)');
    expect(deleteManySection).toContain('removeEntryFromInsightsWithinTransaction(entry)');
    expect(deleteManySection).toContain('missingIds');
    expect(deleteManySection).not.toContain('this.delete(');
  });

  test('keeps IPC and preload boundaries typed, validated, and bulk-shaped', () => {
    expect(handlers).toContain('IPC_CHANNELS.HISTORY_GET_ENTRY_IDS');
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
    expect(historyView).toContain('let selectedIds = $state<Set<string>>(new Set());');
    expect(historyView).toContain('let selectedCount = $derived(selectedIds.size);');
    expect(historyView).toContain('const ids = await window.murmurMain.getHistoryEntryIds(buildFilters());');
    expect(historyView).toContain('const generation = ++selectionGeneration;');
    expect(historyView).toContain('if (generation !== selectionGeneration) return;');
    expect(historyView).toContain('data-history-selection-count');
    expect(historyView).toContain('aria-live="polite"');
    expect(historyView).toContain('data-history-selection-toggle');
    expect(historyView).toContain('aria-pressed={selectionMode}');
    expect(historyView).toContain('data-history-select-all');
    expect(historyView).toContain('data-history-clear-selection');
    expect(historyView).toContain('data-history-delete-selected');
    expect(historyView).toContain('const result = await window.murmurMain.deleteHistoryEntries(ids);');
    expect(historyView).toContain('result.deletedCount');
    expect(historyView).toContain('result.missingIds.length');
    expect(historyView).toContain('await loadEntries(true);');
    expect(historyView).toContain('if (bulkDeleting || !hasSelection) return;');
    expect(historyView).toContain('selectionFeedback = \'History could not be deleted. Nothing was removed. Try again.\';');
    expect(historyView).toContain('{#if selectionFeedback && !bulkDeleteConfirmOpen}');
    expect(historyView).toContain('function cancelBulkDelete(): void');
    expect(historyView).toContain('exitSelectionMode();\n    closeBulkDeleteDialog();');
    expect(historyView).toContain('clearSelection();\n    if (searchTimeout)');
    expect(historyView).toContain('clearSelection();\n    loadEntries(true);');
    expect(historyView).toContain('if (selectionMode || selectedIds.size > 0) exitSelectionMode();');
  });

  test('makes row selection and confirmation keyboard/screen-reader accessible', () => {
    expect(historyView).toContain('type="checkbox"');
    expect(historyView).toContain('aria-label={`Select transcription from ${formatFullDate(item.timestamp)}`}');
    expect(historyView).toContain('<svelte:window onkeydown={handleWindowKeydown} />');
    expect(historyView).toContain("if (event.key === 'Escape')");
    expect(historyView).toContain('else if (!bulkDeleting) cancelBulkDelete();');
    expect(historyView).toContain("if (event.key === 'Tab')");
    expect(historyView).toContain('bulkDeleteTrigger = document.activeElement instanceof HTMLElement');
    expect(historyView).toContain('if (trigger?.isConnected) trigger.focus();');
    expect(historyView).toContain('else selectionToggle?.focus();');
    expect(historyView).toContain('role="dialog"');
    expect(historyView).toContain('aria-labelledby="bulk-delete-dialog-title"');
    expect(historyView).toContain('aria-describedby="bulk-delete-dialog-description"');
    expect(historyView).toContain('Exactly {selectedCount} selected');
    expect(historyView).toContain('disabled={bulkDeleting}');
    expect(historyView).toContain('aria-busy={bulkDeleting}');
  });
});
