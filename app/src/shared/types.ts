// Recording/Session states
export type RecordingState = 'idle' | 'listening' | 'transcribing' | 'processing' | 'success' | 'error';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

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
  // Transcription
  partialEmissionInterval: number; // Minimum seconds between partial transcription updates
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
  // Transcription
  partialEmissionInterval: 0.2, // 200ms default
};
