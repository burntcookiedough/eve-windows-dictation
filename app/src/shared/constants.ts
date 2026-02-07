// IPC Channel names
export const IPC_CHANNELS = {
  // Main → Renderer (state updates)
  STATE_RECORDING: 'state:recording',
  STATE_CONNECTION: 'state:connection',
  STATE_TRANSCRIPTION: 'state:transcription',

  // Main → Renderer (commands to start/stop audio capture)
  COMMAND_START_RECORDING: 'command:start-recording',
  COMMAND_STOP_RECORDING: 'command:stop-recording',

  // Renderer → Main (audio data)
  AUDIO_DATA: 'audio:data',

  // Renderer → Main (commands)
  COMMAND_COPY_TO_CLIPBOARD: 'command:copy-to-clipboard',

  // Main window controls
  MAIN_WINDOW_CLOSE: 'main-window:close',
  MAIN_WINDOW_MINIMIZE: 'main-window:minimize',
  MAIN_WINDOW_MAXIMIZE: 'main-window:maximize',

  // Request/Response
  GET_APP_VERSION: 'get:app-version',
  GET_SETTINGS: 'get:settings',
  UPDATE_SETTING: 'update:setting',
  HOTWORDS_IMPORT: 'hotwords:import',
  HOTWORDS_EXPORT: 'hotwords:export',

  // Hotkey capture
  HOTKEY_START_CAPTURE: 'hotkey:start-capture',
  HOTKEY_CANCEL_CAPTURE: 'hotkey:cancel-capture',
  HOTKEY_GET_DISPLAY_NAME: 'hotkey:get-display-name',

  // History
  HISTORY_GET_ENTRIES: 'history:get-entries',
  HISTORY_DELETE: 'history:delete',
  HISTORY_NEW_ENTRY: 'history:new-entry',

  // Recording test controls
  RECORDING_GET_STATE: 'recording:get-state',
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',
  RECORDING_TOGGLE: 'recording:toggle',

  // Server management - Request/Response
  SERVER_GET_STATUS: 'server:get-status',
  SERVER_START: 'server:start',
  SERVER_STOP: 'server:stop',
  SERVER_RESTART: 'server:restart',
  SERVER_GET_LOGS: 'server:get-logs',

  // Server management - Push (main → renderer)
  SERVER_STATE_CHANGE: 'server:state-change',
  SERVER_LOG: 'server:log',
} as const;

// Overlay window constants
export const OVERLAY_CONFIG = {
  WIDTH: 700,
  HEIGHT: 320,
  BOTTOM_MARGIN: 80,
} as const;

// Audio processing constants
export const AUDIO_CONFIG = {
  SAMPLE_RATE: 16000,
  FRAME_SIZE: 1600, // 100ms at 16kHz
  LEVEL_UPDATE_FPS: 30,
  WAVEFORM_BARS: 26,
} as const;

// Main window constants
export const MAIN_WINDOW_CONFIG = {
  WIDTH: 600,
  HEIGHT: 900,
  MIN_WIDTH: 400,
  MIN_HEIGHT: 600,
} as const;
