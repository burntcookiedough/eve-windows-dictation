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

// Transcription history entry (for future use)
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

// Settings (v0 uses hardcoded values, but define the shape)
export interface Settings {
  hotkey: string;
  holdToTalk: boolean;
  autoCopy: boolean;
  autoPaste: boolean;
  silenceTimeout: number;
  serverUrl: string;
  theme: 'light' | 'dark' | 'system';
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
};
