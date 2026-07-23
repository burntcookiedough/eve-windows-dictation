import { app, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type { HistoryFilters, Settings, Hotkey } from '../../shared/types.js';
import { formatHotwordsCsl, parseHotwordsCsl } from '../../shared/hotwords.js';
import { isInsightsRange } from '../../shared/insights.js';
import { copyToClipboard } from '../services/clipboard.js';
import { formatDiagnosticsReport } from '../services/diagnostics-report.js';
import type { HistoryService } from '../services/history.js';
import type { ServerManager } from '../services/server-manager.js';
import { getSetting, getSettings, updateSetting } from '../services/settings.js';
import {
  getServerSettings,
  updateServerSettings,
  getEngineStatus,
  getAvailableEngines,
} from '../services/server-settings.js';
import { startHotkeyCapture, cancelHotkeyCapture } from '../services/hotkey.js';
import { formatHotkey } from '../services/keycodes.js';
import { validateLaunchOnBootUpdate } from '../login-item-policy.js';

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

  // Handle clipboard copy requests
  ipcMain.on(IPC_CHANNELS.COMMAND_COPY_TO_CLIPBOARD, (_event, text: string) => {
    copyToClipboard(text);
  });

  ipcMain.handle(IPC_CHANNELS.COMMAND_COPY_DIAGNOSTICS, () => {
    const report = formatDiagnosticsReport({
      appVersion: app.getVersion(),
      windowsRelease: release(),
      architecture: arch(),
      serverState: serverManagerRef?.getState(),
    });
    copyToClipboard(report);
  });

  // Handle settings requests
  ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, () => {
    return getSettings();
  });

  // Handle setting updates
  ipcMain.handle(
    IPC_CHANNELS.UPDATE_SETTING,
    async (_event, key: keyof Settings, value: Settings[keyof Settings]) => {
      if (key === 'launchOnBoot') {
        validateLaunchOnBootUpdate(value);
      }

      updateSetting(key, value);

      if (key === 'useExternalServer' && value === true && serverManagerRef) {
        await serverManagerRef.stop();
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.HOTWORDS_IMPORT, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Hotwords',
      properties: ['openFile'],
      filters: [
        { name: 'Text and CSV', extensions: ['txt', 'csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const content = await readFile(result.filePaths[0]!, 'utf-8');
    return formatHotwordsCsl(parseHotwordsCsl(content));
  });

  ipcMain.handle(IPC_CHANNELS.HOTWORDS_EXPORT, async (_event, hotwordsCsl: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Export Hotwords',
      defaultPath: 'murmur-hotwords.csv',
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return false;
    }

    const normalized = formatHotwordsCsl(parseHotwordsCsl(hotwordsCsl));
    await writeFile(result.filePath, normalized, 'utf-8');
    return true;
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

  ipcMain.handle(IPC_CHANNELS.INSIGHTS_GET, (_event, range: unknown) => {
    if (!isInsightsRange(range)) {
      throw new TypeError('Invalid insights range');
    }
    if (!historyServiceRef) {
      return null;
    }
    return historyServiceRef.getInsights(range);
  });

  ipcMain.handle(IPC_CHANNELS.INSIGHTS_REBUILD, () => {
    if (!historyServiceRef) {
      return;
    }
    historyServiceRef.rebuildInsights();
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
    if (getSetting('useExternalServer')) {
      throw new Error('Server management is disabled while external server mode is enabled');
    }
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
    if (getSetting('useExternalServer')) {
      throw new Error('Server management is disabled while external server mode is enabled');
    }
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

  // Server settings (REST API proxy)
  ipcMain.handle(IPC_CHANNELS.GET_SERVER_SETTINGS, async () => {
    return getServerSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.UPDATE_SERVER_SETTINGS,
    async (_event, patch: Record<string, unknown>) => {
      return updateServerSettings(patch);
    }
  );

  ipcMain.handle(IPC_CHANNELS.GET_ENGINE_STATUS, async () => {
    return getEngineStatus();
  });

  ipcMain.handle(IPC_CHANNELS.GET_AVAILABLE_ENGINES, async () => {
    return getAvailableEngines();
  });
}
