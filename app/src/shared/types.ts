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

// Settings (v0 uses hardcoded values, but define the shape)
export interface Settings {
  hotkey: string;
  holdToTalk: boolean;
  autoCopy: boolean;
  autoPaste: boolean;
  silenceTimeout: number;
  serverUrl: string;
  theme: 'light' | 'dark' | 'system';
  // Post-processing
  appendPeriod: boolean;
  appendSpace: boolean;
}

// Default settings for v0
export const DEFAULT_SETTINGS: Settings = {
  hotkey: 'F17',
  holdToTalk: true,
  autoCopy: true,
  autoPaste: true,
  silenceTimeout: 3,
  serverUrl: 'ws://localhost:51717/transcribe',
  theme: 'dark',
  // Post-processing
  appendPeriod: false,
  appendSpace: false,
};
