import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type {
  HistoryFilters,
  HistoryDeleteResult,
  HistoryExportRequest,
  HistoryExportResult,
  HistoryResponse,
  HistoryEntryWithGroup,
  InsightsRange,
  InsightsResponse,
  Settings,
  Hotkey,
  ServerStatePayload,
  ServerLogEntry,
  RecordingDebugState,
  RecordingStatePayload,
  ConnectionStatePayload,
  TranscriptionPayload,
  ServerSettingsResponse,
  EngineStatus,
  AvailableEngine,
  GpuPackState,
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

  getSettings: (): Promise<Settings> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS);
  },

  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SETTING, key, value);
  },

  onSettingsChanged: (callback: (settings: Settings) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: Settings) => callback(settings);
    ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, handler);
  },

  onAudioLevel: (callback: (level: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, level: number) => callback(level);
    ipcRenderer.on(IPC_CHANNELS.STATE_AUDIO_LEVEL, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STATE_AUDIO_LEVEL, handler);
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

  getHistoryEntryIds: (filters?: HistoryFilters): Promise<string[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_GET_ENTRY_IDS, filters);
  },

  exportHistory: (request: HistoryExportRequest): Promise<HistoryExportResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_EXPORT, request);
  },

  deleteHistoryEntry: (id: string): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_DELETE, id);
  },

  deleteHistoryEntries: (ids: string[]): Promise<HistoryDeleteResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_DELETE_BULK, ids);
  },

  getInsights: (range: InsightsRange): Promise<InsightsResponse | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_GET, range);
  },

  rebuildInsights: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_REBUILD);
  },

  onNewHistoryEntry: (callback: (entry: HistoryEntryWithGroup) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: HistoryEntryWithGroup) => {
      callback(entry);
    };
    ipcRenderer.on(IPC_CHANNELS.HISTORY_NEW_ENTRY, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.HISTORY_NEW_ENTRY, handler);
  },

  // Clipboard
  copyToClipboard: (text: string): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COMMAND_COPY_TO_CLIPBOARD, text);
  },

  copyDiagnostics: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COMMAND_COPY_DIAGNOSTICS);
  },

  // Recording controls and state (for Test view)
  getRecordingDebugState: (): Promise<RecordingDebugState> => {
    return ipcRenderer.invoke(IPC_CHANNELS.RECORDING_GET_STATE);
  },

  startRecording: (): Promise<RecordingDebugState> => {
    return ipcRenderer.invoke(IPC_CHANNELS.RECORDING_START);
  },

  stopRecording: (): Promise<RecordingDebugState> => {
    return ipcRenderer.invoke(IPC_CHANNELS.RECORDING_STOP);
  },

  toggleRecording: (): Promise<RecordingDebugState> => {
    return ipcRenderer.invoke(IPC_CHANNELS.RECORDING_TOGGLE);
  },

  onRecordingState: (callback: (payload: RecordingStatePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RecordingStatePayload) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.STATE_RECORDING, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STATE_RECORDING, handler);
  },

  onConnectionState: (callback: (payload: ConnectionStatePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ConnectionStatePayload) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.STATE_CONNECTION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STATE_CONNECTION, handler);
  },

  onTranscription: (callback: (payload: TranscriptionPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TranscriptionPayload) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.STATE_TRANSCRIPTION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STATE_TRANSCRIPTION, handler);
  },

  removeRecordingListeners: (): void => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_AUDIO_LEVEL);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_RECORDING);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_CONNECTION);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_TRANSCRIPTION);
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

  // Optional GPU runtime pack (independent from Python server state)
  getGpuPackState: (): Promise<GpuPackState> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GPU_PACK_GET_STATE);
  },

  installGpuPack: (): Promise<GpuPackState> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GPU_PACK_INSTALL);
  },

  onGpuPackStateChange: (callback: (state: GpuPackState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: GpuPackState) => {
      callback(state);
    };
    ipcRenderer.on(IPC_CHANNELS.GPU_PACK_STATE_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.GPU_PACK_STATE_CHANGE, handler);
  },

  onServerStateChange: (callback: (state: ServerStatePayload) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ServerStatePayload) => {
      callback(state);
    };
    ipcRenderer.on(IPC_CHANNELS.SERVER_STATE_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SERVER_STATE_CHANGE, handler);
  },

  onServerLog: (callback: (entry: ServerLogEntry) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: ServerLogEntry) => {
      callback(entry);
    };
    ipcRenderer.on(IPC_CHANNELS.SERVER_LOG, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SERVER_LOG, handler);
  },

  removeServerListeners: (): void => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SERVER_STATE_CHANGE);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SERVER_LOG);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.GPU_PACK_STATE_CHANGE);
  },

  // Server settings (REST API proxy)
  getServerSettings: (): Promise<ServerSettingsResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_SERVER_SETTINGS);
  },

  updateServerSettings: (patch: Record<string, unknown>): Promise<ServerSettingsResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SERVER_SETTINGS, patch);
  },

  getEngineStatus: (): Promise<EngineStatus> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_ENGINE_STATUS);
  },

  getAvailableEngines: (): Promise<AvailableEngine[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_AVAILABLE_ENGINES);
  },

  // Cleanup
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SETTINGS_CHANGED);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_AUDIO_LEVEL);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.HISTORY_NEW_ENTRY);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SERVER_STATE_CHANGE);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.SERVER_LOG);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_RECORDING);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_CONNECTION);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_TRANSCRIPTION);
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
