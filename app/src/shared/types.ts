// Recording/Session states
export type RecordingState = 'idle' | 'listening' | 'transcribing' | 'processing' | 'success' | 'error';
export type DictationSessionMode = 'quick' | 'long';
export type InsightsRange = 'today' | '7d' | '30d' | 'all';

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
  engineStatus?: EngineStatus;
  diagnostics?: ServerDiagnostics;
  modelDownload?: ModelDownloadState;
}

export interface ServerLogEntry {
  timestamp: number;
  level: 'stdout' | 'stderr';
  message: string;
}

export interface DiagnosticWarning {
  code: string;
  message: string;
  action?: string;
  url?: string;
  severity: 'warning' | 'error';
}

export interface CudaDiagnostics {
  available: boolean;
  device: string;
  reason?: string | null;
  name?: string | null;
  compute_capability?: string | null;
}

export interface CudaDllDiagnostics {
  available: boolean;
  detail?: string | null;
}

export interface NvidiaDriverDiagnostics {
  available: boolean;
  version?: string | null;
  minimum_version?: string | null;
  meets_minimum?: boolean | null;
}

export interface VcRedistDiagnostics {
  required: boolean;
  installed?: boolean | null;
  missing?: string[] | null;
  url?: string | null;
}

export interface ServerDiagnostics {
  generated_at: string;
  cuda: CudaDiagnostics;
  cuda_dlls: CudaDllDiagnostics;
  nvidia_driver: NvidiaDriverDiagnostics;
  vc_redist: VcRedistDiagnostics;
  warnings: DiagnosticWarning[];
}

export interface ModelDownloadState {
  model: string;
  size_gb: number;
  status: 'missing' | 'partial' | 'downloading' | 'ready' | 'error';
  cached?: boolean;
  detail?: string;
  repo_id?: string;
  path?: string;
  missing_files?: string[];
  partial_files?: string[];
  updated_at?: string;
  phase?: 'checking' | 'downloading' | 'loading' | 'ready' | 'error';
  progress_percent?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  bytes_per_second?: number;
  eta_seconds?: number;
  current_file?: string;
  started_at?: string;
}

// IPC State payloads
export interface RecordingStatePayload {
  state: RecordingState;
  isRecording: boolean;
  mode?: DictationSessionMode;
}

export interface ConnectionStatePayload {
  status: ConnectionState;
  error?: string;
}

export interface RecordingWarningPayload {
  code: string;
  message: string;
}

export interface AudioCaptureErrorPayload {
  code: string;
  message: string;
  deviceId?: string;
}

export interface RecordingStatusPayload {
  status: 'long_dictation_started' | 'long_dictation_processing';
  message?: string;
  chunkIndex?: number;
  chunkTotal?: number;
  audioDuration?: number;
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
  wordCount?: number;
  sessionMode?: DictationSessionMode;
  engine?: string;
  model?: string;
  device?: string;
  computeType?: string;
  cudaActive?: boolean;
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

export interface InsightSourceEntry {
  id: string;
  timestamp: number;
  text: string;
  audioDuration: number;
  transcriptionTime: number;
  confidence: number;
  wordCount?: number;
}

export interface InsightsSummary {
  totalDictations: number;
  totalWords: number;
  totalAudioSeconds: number;
  totalProcessingMs: number;
  avgConfidence: number;
  avgWpm: number;
  avgProcessingRatio: number;
  avgWordsPerDictation: number;
  longestStreakDays: number;
  busiestDay?: {
    date: string;
    label: string;
    words: number;
    dictations: number;
  };
}

export interface InsightsTrendPoint {
  date: string;
  label: string;
  dictations: number;
  words: number;
  audioSeconds: number;
  processingMs: number;
  avgWpm: number;
  avgConfidence: number;
  avgProcessingRatio: number;
}

export interface InsightsWordStat {
  text: string;
  count: number;
}

export interface InsightsEntryStat {
  id: string;
  timestamp: number;
  text: string;
  wordCount: number;
  audioDuration: number;
  transcriptionTime: number;
  processingRatio: number;
}

export interface InsightsResponse {
  range: InsightsRange;
  generatedAt: number;
  hasData: boolean;
  indexing: {
    isIndexing: boolean;
    processedEntries: number;
    totalEntries: number;
  };
  summary: InsightsSummary;
  trends: InsightsTrendPoint[];
  commonWords: InsightsWordStat[];
  commonPhrases: InsightsWordStat[];
  longestEntries: InsightsEntryStat[];
  slowestEntries: InsightsEntryStat[];
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
  longHotkey: Hotkey;
  holdToTalk: boolean;
  autoCopy: boolean;
  autoPaste: boolean;
  restoreClipboardAfterPaste: boolean;
  clipboardRestoreDelayMs: number;
  pasteMethod: 'sendinput' | 'vbscript';
  silenceTimeout: number;
  serverUrl: string;
  // Post-processing
  appendPeriod: boolean;
  appendSpace: boolean;
  dictationMode: 'raw' | 'clean_prompt' | 'codex_prompt' | 'message_rewrite' | 'command';
  // Audio
  selectedDeviceId: string; // 'default' uses system default
  // Startup behavior
  launchOnBoot: boolean;
  startMinimized: boolean;
  // Server management
  serverAutoStart: boolean; // Auto-start server in production mode
  useExternalServer: boolean; // Bypass managed server and use custom serverUrl
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
  gpu_name?: string | null;
  gpu_vram_gb?: number | null;
  estimated_max_duration_s?: number | null;
  repo_id?: string | null;
  model_path?: string | null;
  device?: string | null;
  compute_type?: string | null;
  cuda_active?: boolean | null;
  load_time_s?: number | null;
  last_transcription_latency_s?: number | null;
  vram_used_gb?: number | null;
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
  available_engines?: string[];
  reload_required?: boolean;
  reload_started?: boolean;
  active_sessions?: number;
  note?: string;
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
export const DEFAULT_SETTINGS: Settings = {
  hotkey: {
    keycode: 3675, // Meta/Windows in libuiohook
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  },
  longHotkey: {
    keycode: 3675, // Ctrl+Shift+Win in the Windows UI; Meta in libuiohook storage
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
    metaKey: false,
  },
  holdToTalk: true,
  autoCopy: true,
  autoPaste: true,
  restoreClipboardAfterPaste: true,
  clipboardRestoreDelayMs: 250,
  pasteMethod: 'sendinput',
  silenceTimeout: 15,
  serverUrl: 'ws://localhost:51717/transcribe',
  // Post-processing
  appendPeriod: false,
  appendSpace: false,
  dictationMode: 'clean_prompt',
  // Audio
  selectedDeviceId: 'default',
  // Startup behavior
  launchOnBoot: false,
  startMinimized: false,
  // Server management
  serverAutoStart: true,
  useExternalServer: false,
  // Recognition vocabulary hints
  hotwordsEnabled: false,
  hotwordsCsl: '',
};
