import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
import type { HistoryFilters } from '../../shared/types.js';
import { copyToClipboard } from '../services/clipboard.js';
import type { HistoryService } from '../services/history.js';

let historyServiceRef: HistoryService | null = null;

export function setupIpcHandlers(historyService?: HistoryService): void {
  // Store reference to history service
  if (historyService) {
    historyServiceRef = historyService;
  }

  // Handle clipboard copy requests
  ipcMain.on(IPC_CHANNELS.COMMAND_COPY_TO_CLIPBOARD, (_event, text: string) => {
    copyToClipboard(text);
  });

  // Handle settings requests
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, () => {
    // For v0, return hardcoded defaults
    return DEFAULT_SETTINGS;
  });

  // Handle history get entries
  ipcMain.handle(
    IPC_CHANNELS.HISTORY_GET_ENTRIES,
    (_event, offset: number, limit: number, filters?: HistoryFilters) => {
      if (!historyServiceRef) {
        return { entries: [], hasMore: false };
      }
      return historyServiceRef.getEntries(offset, limit, filters);
    }
  );

  // Handle history delete
  ipcMain.handle(IPC_CHANNELS.HISTORY_DELETE, (_event, id: string) => {
    if (!historyServiceRef) {
      return;
    }
    historyServiceRef.delete(id);
  });
}
