// Recording/Session states
export type RecordingState = 'idle' | 'listening' | 'transcribing' | 'processing' | 'success' | 'error';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// Server management states
export type ServerStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface ServerPidFile {
  pid: number;
  port: number;
  startedAt: number;
}

export interface ServerStatePayload {
  status: ServerStatus;
  pid?: number;
  port?: number;
  version?: string;
  uptime?: number;
  error?: string;
  wsUrl?: string;
  managed: boolean; // false in dev mode (externally running server)
}

export interface ServerLogEntry {
  timestamp: number;
  level: 'stdout' | 'stderr';
  message: string;
}

// IPC State payloads
export interface RecordingStatePayload {
  state: RecordingState;
  isRecording: boolean;
}

export interface ConnectionStatePayload {
  status: ConnectionState;
  error?: string;
}

export interface AudioLevelPayload {
  levels: number[]; // RMS values for waveform bars
}

export interface TranscriptionPayload {
  type: 'partial' | 'final';
  text: string;
  confidence: number;
}

export interface RecordingDebugState {
  recording: RecordingStatePayload;
  connection: ConnectionStatePayload;
  transcription: TranscriptionPayload | null;
}

// Transcription history entry
export interface TranscriptionEntry {
  id: string;
  timestamp: number;
  text: string;
  audioDuration: number;
  confidence: number;
  transcriptionTime: number;
  editedAt?: number;
  originalText?: string;
}

// History entry with date group for UI display
export interface HistoryEntryWithGroup extends TranscriptionEntry {
  dateGroup: string; // "Today", "Yesterday", "This Week", "Jan 15", etc.
}

// Filters for history queries
export interface HistoryFilters {
  text?: string;
  dateFrom?: number;
  dateTo?: number;
  minDuration?: number;
  maxDuration?: number;
  minConfidence?: number;
  editedOnly?: boolean;
}

// Response from history queries
export interface HistoryResponse {
  entries: HistoryEntryWithGroup[];
  hasMore: boolean;
}

// Hotkey configuration
export interface Hotkey {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

// Settings (v0 uses hardcoded values, but define the shape)
export interface Settings {
  hotkey: Hotkey;
  holdToTalk: boolean;
  autoCopy: boolean;
  autoPaste: boolean;
  silenceTimeout: number;
  serverUrl: string;
  // Post-processing
  appendPeriod: boolean;
  appendSpace: boolean;
  // Audio
  selectedDeviceId: string; // 'default' uses system default
  // Startup behavior
  launchOnBoot: boolean;
  startMinimized: boolean;
  // Server management
  serverAutoStart: boolean; // Auto-start server in production mode
  // Recognition vocabulary hints
  hotwordsEnabled: boolean;
  hotwordsCsl: string;
}

// Server settings types (fetched from server REST API)
export interface ServerSetting<T> {
  value: T;
  label: string;
  description: string;
  type: 'select' | 'number' | 'bool' | 'text';
  options?: Array<{ value: T; label: string; description?: string }>;
  range?: [number, number];
  requires_reload: boolean;
  category: string;
  visible_when?: Record<string, unknown>;
  readonly?: boolean;
}

export interface EngineInfo {
  id: string;
  name: string;
  model: string;
  supports_hotwords: boolean;
  languages: string[];
  model_size_gb: number;
}

export interface EngineStatus {
  current: string;
  status: 'loading' | 'ready' | 'error';
  info?: EngineInfo;
  message?: string;
  pending?: {
    engine: string;
    status: 'loading' | 'ready' | 'error';
    message?: string;
  };
}

export interface ServerSettingsResponse {
  settings: Record<string, ServerSetting<unknown>>;
  engine_status: EngineStatus;
  available_engines: string[];
}

export interface AvailableEngine {
  id: string;
  name: string;
  available: boolean;
  description: string;
  model_size_gb: number;
  languages: string[];
  features: string[];
  install_hint?: string;
}

// Window bounds for position/size persistence
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Default settings for v0
// F17 keycode: 0x0064 (100) in libuiohook, 128 on Windows
export const DEFAULT_SETTINGS: Settings = {
  hotkey: {
    keycode: 100, // F17 in libuiohook (0x0064)
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  },
  holdToTalk: true,
  autoCopy: true,
  autoPaste: true,
  silenceTimeout: 15,
  serverUrl: 'ws://localhost:51717/transcribe',
  // Post-processing
  appendPeriod: false,
  appendSpace: false,
  // Audio
  selectedDeviceId: 'default',
  // Startup behavior
  launchOnBoot: false,
  startMinimized: false,
  // Server management
  serverAutoStart: true,
  // Recognition vocabulary hints
  hotwordsEnabled: false,
  hotwordsCsl: '',
};
