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
  GET_SETTINGS: 'get:settings',
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
  WIDTH: 900,
  HEIGHT: 600,
  MIN_WIDTH: 600,
  MIN_HEIGHT: 400,
} as const;
