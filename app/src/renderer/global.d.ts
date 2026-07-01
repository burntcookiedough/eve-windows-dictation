import type {
  AvailableEngine,
  ConnectionStatePayload,
  EngineStatus,
  HistoryEntryWithGroup,
  HistoryFilters,
  HistoryResponse,
  Hotkey,
  RecordingDebugState,
  RecordingStatePayload,
  RecordingStatusPayload,
  RecordingWarningPayload,
  ServerLogEntry,
  ServerSettingsResponse,
  ServerStatePayload,
  Settings,
  TranscriptionPayload,
} from '$shared/types';

declare global {
  interface Window {
    murmurMain: {
      closeWindow: () => void;
      minimizeWindow: () => void;
      maximizeWindow: () => void;
      getAppVersion: () => Promise<string>;
      getSettings: () => Promise<Settings>;
      updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
      importHotwordsFromFile: () => Promise<string | null>;
      exportHotwordsToFile: (hotwordsCsl: string) => Promise<boolean>;
      startHotkeyCapture: () => Promise<{ hotkey: Hotkey; displayName: string }>;
      cancelHotkeyCapture: () => Promise<void>;
      getHotkeyDisplayName: (hotkey: Hotkey) => Promise<string>;
      getHistoryEntries: (offset: number, limit: number, filters?: HistoryFilters) => Promise<HistoryResponse>;
      deleteHistoryEntry: (id: string) => Promise<void>;
      onNewHistoryEntry: (callback: (entry: HistoryEntryWithGroup) => void) => void;
      removeNewHistoryEntryListener: () => void;
      copyToClipboard: (text: string) => void;
      getRecordingDebugState: () => Promise<RecordingDebugState>;
      startRecording: () => Promise<RecordingDebugState>;
      stopRecording: () => Promise<RecordingDebugState>;
      toggleRecording: () => Promise<RecordingDebugState>;
      onRecordingState: (callback: (payload: RecordingStatePayload) => void) => () => void;
      onConnectionState: (callback: (payload: ConnectionStatePayload) => void) => () => void;
      onTranscription: (callback: (payload: TranscriptionPayload) => void) => () => void;
      removeRecordingListeners: () => void;
      getServerStatus: () => Promise<ServerStatePayload>;
      startServer: () => Promise<ServerStatePayload>;
      stopServer: () => Promise<ServerStatePayload>;
      restartServer: () => Promise<ServerStatePayload>;
      getServerLogs: () => Promise<ServerLogEntry[]>;
      onServerStateChange: (callback: (state: ServerStatePayload) => void) => void;
      onServerLog: (callback: (entry: ServerLogEntry) => void) => void;
      removeServerListeners: () => void;
      getServerSettings: () => Promise<ServerSettingsResponse>;
      updateServerSettings: (patch: Record<string, unknown>) => Promise<ServerSettingsResponse>;
      getEngineStatus: () => Promise<EngineStatus>;
      getAvailableEngines: () => Promise<AvailableEngine[]>;
      removeAllListeners: () => void;
    };
    murmur: {
      onRecordingState: (callback: (state: RecordingStatePayload) => void) => () => void;
      onConnectionState: (callback: (state: ConnectionStatePayload) => void) => () => void;
      onTranscription: (callback: (data: TranscriptionPayload) => void) => () => void;
      onWarning: (callback: (warning: RecordingWarningPayload) => void) => () => void;
      onStatus: (callback: (status: RecordingStatusPayload) => void) => () => void;
      onStartRecording: (callback: (deviceId?: string) => void) => () => void;
      onStopRecording: (callback: () => void) => () => void;
      sendAudioData: (buffer: ArrayBuffer) => void;
      copyToClipboard: (text: string) => void;
      removeAllListeners: () => void;
    };
  }
}

export {};
