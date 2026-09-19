import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const constants = source('../src/shared/constants.ts');
const handlers = source('../src/main/ipc/handlers.ts');
const preload = source('../src/main/preload/main.ts');
const rendererTypes = source('../src/renderer/global.d.ts');
const historyView = source('../src/renderer/app/views/HistoryView.svelte');

describe('History export application boundary', () => {
  test('keeps the request typed and validated across IPC', () => {
    expect(constants).toContain("HISTORY_EXPORT: 'history:export'");
    expect(handlers).toContain('isHistoryExportRequest(request)');
    expect(handlers).toContain("throw new TypeError('Invalid history export request')");
    expect(handlers).toContain('dialog.showSaveDialog');
    expect(handlers).toContain('const snapshot = historyServiceRef.createExportSnapshot()');
    expect(handlers).toContain('exportHistoryToFile(snapshot, request, result.filePath)');
    expect(handlers).toContain('snapshot.close()');
    expect(preload).toContain('exportHistory: (request: HistoryExportRequest): Promise<HistoryExportResult>');
    expect(preload).toContain('ipcRenderer.invoke(IPC_CHANNELS.HISTORY_EXPORT, request)');
    expect(rendererTypes).toContain('exportHistory: (request: HistoryExportRequest) => Promise<HistoryExportResult>');
  });

  test('reuses Eve controls and keeps all versus selected scope explicit', () => {
    expect(historyView).toContain("import EveDropdown from '../components/EveDropdown.svelte'");
    expect(historyView).toContain('label="History export format"');
    expect(historyView).toContain('data-history-export-all');
    expect(historyView).toContain('aria-label="Export all history"');
    expect(historyView).toContain('data-history-export-selected');
    expect(historyView).toContain("onclick={() => exportHistory('all')}");
    expect(historyView).toContain("onclick={() => exportHistory('selected')}");
    expect(historyView).toContain("scope === 'selected' && !hasSelection");
    expect(historyView).toContain('aria-busy={exporting}');
    expect(historyView).toContain('Export all history, or select entries to export a filtered subset.');
    expect(historyView).not.toContain('<select');
    expect(historyView).not.toMatch(/\b(?:blue|sky|violet|purple|cyan)-/);
  });
});
