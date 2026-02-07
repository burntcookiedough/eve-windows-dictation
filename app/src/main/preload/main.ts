import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type {
  HistoryFilters,
  HistoryResponse,
  HistoryEntryWithGroup,
  Settings,
  Hotkey,
  ServerStatePayload,
  ServerLogEntry,
} from '../../shared/types.js';

// Define the API exposed to the main window renderer
const murmurMainAPI = {
  // Window controls
  closeWindow: () => {
    ipcRenderer.send(IPC_CHANNELS.MAIN_WINDOW_CLOSE);
  },

  minimizeWindow: () => {
    ipcRenderer.send(IPC_CHANNELS.MAIN_WINDOW_MINIMIZE);
  },

  maximizeWindow: () => {
    ipcRenderer.send(IPC_CHANNELS.MAIN_WINDOW_MAXIMIZE);
  },

  // Settings
  getAppVersion: (): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION);
  },

  getSettings: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS);
  },

  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SETTING, key, value);
  },

  importHotwordsFromFile: (): Promise<string | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOTWORDS_IMPORT);
  },

  exportHotwordsToFile: (hotwordsCsl: string): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOTWORDS_EXPORT, hotwordsCsl);
  },

  // Hotkey capture
  startHotkeyCapture: (): Promise<{ hotkey: Hotkey; displayName: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_START_CAPTURE);
  },

  cancelHotkeyCapture: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_CANCEL_CAPTURE);
  },

  getHotkeyDisplayName: (hotkey: Hotkey): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_GET_DISPLAY_NAME, hotkey);
  },

  // History
  getHistoryEntries: (offset: number, limit: number, filters?: HistoryFilters): Promise<HistoryResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_GET_ENTRIES, offset, limit, filters);
  },

  deleteHistoryEntry: (id: string): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_DELETE, id);
  },

  onNewHistoryEntry: (callback: (entry: HistoryEntryWithGroup) => void): void => {
    ipcRenderer.on(IPC_CHANNELS.HISTORY_NEW_ENTRY, (_event, entry) => {
      callback(entry);
    });
  },

  removeNewHistoryEntryListener: (): void => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.HISTORY_NEW_ENTRY);
  },

  // Clipboard
  copyToClipboard: (text: string): void => {
    ipcRenderer.send(IPC_CHANNELS.COMMAND_COPY_TO_CLIPBOARD, text);
  },

  // Server management
  getServerStatus: (): Promise<ServerStatePayload> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_STATUS);
  },

  startServer: (): Promise<ServerStatePayload> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SERVER_START);
  },

  stopServer: (): Promise<ServerStatePayload> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SERVER_STOP);
  },

  restartServer: (): Promise<ServerStatePayload> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SERVER_RESTART);
  },

  getServerLogs: (): Promise<ServerLogEntry[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_LOGS);
  },

  onServerStateChange: (callback: (state: ServerStatePayload) => void): void => {
    ipcRenderer.on(IPC_CHANNELS.SERVER_STATE_CHANGE, (_event, state) => {
      callback(state);
    });
  },

  onServerLog: (callback: (entry: ServerLogEntry) => void): void => {
    ipcRenderer.on(IPC_CHANNELS.SERVER_LOG, (_event, entry) => {
      callback(entry);
    });
  },

  removeServerListeners: (): void => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SERVER_STATE_CHANGE);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SERVER_LOG);
  },

  // Cleanup
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.HISTORY_NEW_ENTRY);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SERVER_STATE_CHANGE);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SERVER_LOG);
  },
};

// Expose the API to the renderer
contextBridge.exposeInMainWorld('murmurMain', murmurMainAPI);

// TypeScript declaration for the exposed API
export type MurmurMainAPI = typeof murmurMainAPI;

declare global {
  interface Window {
    murmurMain: typeof murmurMainAPI;
  }
}
