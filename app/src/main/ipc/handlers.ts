import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type { HistoryFilters, Settings } from '../../shared/types.js';
import { copyToClipboard } from '../services/clipboard.js';
import type { HistoryService } from '../services/history.js';
import { getSettings, updateSetting } from '../services/settings.js';

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
    return getSettings();
  });

  // Handle setting updates
  ipcMain.handle(
    IPC_CHANNELS.UPDATE_SETTING,
    (_event, key: keyof Settings, value: Settings[keyof Settings]) => {
      updateSetting(key, value);
    }
  );

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
