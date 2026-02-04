import { app, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type { HistoryFilters, Settings, Hotkey } from '../../shared/types.js';
import { copyToClipboard } from '../services/clipboard.js';
import type { HistoryService } from '../services/history.js';
import type { ServerManager } from '../services/server-manager.js';
import { getSettings, updateSetting } from '../services/settings.js';
import { startHotkeyCapture, cancelHotkeyCapture } from '../services/hotkey.js';
import { formatHotkey } from '../services/keycodes.js';

/**
 * Apply the launch-on-boot setting using Electron's login item API.
 */
function applyLaunchOnBoot(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
  });
}

let historyServiceRef: HistoryService | null = null;
let serverManagerRef: ServerManager | null = null;

export function setupIpcHandlers(historyService?: HistoryService, serverManager?: ServerManager): void {
  // Store references to services
  if (historyService) {
    historyServiceRef = historyService;
  }
  if (serverManager) {
    serverManagerRef = serverManager;
  }

  // Sync launch-on-boot setting with OS on startup
  const settings = getSettings();
  applyLaunchOnBoot(settings.launchOnBoot);

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

      // Apply launch-on-boot immediately when changed
      if (key === 'launchOnBoot') {
        applyLaunchOnBoot(value as boolean);
      }
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

  // Handle hotkey capture
  ipcMain.handle(IPC_CHANNELS.HOTKEY_START_CAPTURE, async () => {
    return startHotkeyCapture();
  });

  ipcMain.handle(IPC_CHANNELS.HOTKEY_CANCEL_CAPTURE, () => {
    cancelHotkeyCapture();
  });

  // Get display name for a hotkey (for initial render)
  ipcMain.handle(IPC_CHANNELS.HOTKEY_GET_DISPLAY_NAME, (_event, hotkey: Hotkey) => {
    return formatHotkey(hotkey);
  });

  // Server management handlers
  ipcMain.handle(IPC_CHANNELS.SERVER_GET_STATUS, () => {
    if (!serverManagerRef) {
      return { status: 'idle', managed: false };
    }
    return serverManagerRef.getState();
  });

  ipcMain.handle(IPC_CHANNELS.SERVER_START, async () => {
    if (!serverManagerRef) {
      throw new Error('Server manager not initialized');
    }
    await serverManagerRef.start();
    return serverManagerRef.getState();
  });

  ipcMain.handle(IPC_CHANNELS.SERVER_STOP, async () => {
    if (!serverManagerRef) {
      throw new Error('Server manager not initialized');
    }
    await serverManagerRef.stop();
    return serverManagerRef.getState();
  });

  ipcMain.handle(IPC_CHANNELS.SERVER_RESTART, async () => {
    if (!serverManagerRef) {
      throw new Error('Server manager not initialized');
    }
    await serverManagerRef.restart();
    return serverManagerRef.getState();
  });

  ipcMain.handle(IPC_CHANNELS.SERVER_GET_LOGS, () => {
    if (!serverManagerRef) {
      return [];
    }
    return serverManagerRef.getLogs();
  });
}
