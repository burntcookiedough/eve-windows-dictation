import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { createOverlayWindow, showOverlay, hideOverlay, positionOverlayOnActiveDisplay } from './windows/overlay.js';
import { createMainWindow, showMainWindow } from './windows/main.js';
import { setupHotkeyService } from './services/hotkey.js';
import { setupTray } from './services/tray.js';
import { setupIpcHandlers } from './ipc/handlers.js';
import { TranscriptionService } from './services/transcription.js';
import { HistoryService } from './services/history.js';
import { ServerManager } from './services/server-manager.js';
import { processFinalTranscription } from './services/pipeline.js';
import { getSettings, getSetting } from './services/settings.js';
import type { TextFrameFinal } from '../shared/protocol.js';
import { IPC_CHANNELS } from '../shared/constants.js';
import { buildHotwordsPrompt } from '../shared/hotwords.js';
import type {
  RecordingStatePayload,
  ConnectionStatePayload,
  TranscriptionPayload,
  RecordingDebugState,
} from '../shared/types.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('App');

let overlayWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let transcriptionService: TranscriptionService | null = null;
let historyService: HistoryService | null = null;
let serverManager: ServerManager | null = null;
let isRecording = false;
let recordingSource: 'lab' | 'normal' | null = null;
let isStopping = false;
let currentRecordingState: RecordingStatePayload = { state: 'idle', isRecording: false };
let currentConnectionState: ConnectionStatePayload = { status: 'disconnected' };
let latestTranscription: TranscriptionPayload | null = null;

function broadcastLabState<T>(channel: string, payload: T): void {
  if (recordingSource === 'lab' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function updateRecordingState(payload: RecordingStatePayload): void {
  currentRecordingState = payload;
  broadcastLabState(IPC_CHANNELS.STATE_RECORDING, payload);
}

function updateConnectionState(payload: ConnectionStatePayload): void {
  currentConnectionState = payload;
  broadcastLabState(IPC_CHANNELS.STATE_CONNECTION, payload);
}

function updateTranscription(payload: TranscriptionPayload): void {
  latestTranscription = payload;
  broadcastLabState(IPC_CHANNELS.STATE_TRANSCRIPTION, payload);
}

function getRecordingDebugState(): RecordingDebugState {
  if (recordingSource !== 'lab') {
    return {
      recording: { state: 'idle', isRecording: false },
      connection: { status: 'disconnected' },
      transcription: null,
    };
  }

  return {
    recording: currentRecordingState,
    connection: currentConnectionState,
    transcription: latestTranscription,
  };
}

async function startRecording(source: 'lab' | 'normal') {
  if (isRecording || isStopping || !overlayWindow) return;

  // In packaged builds, only trust server URL discovered from the running server.
  const serverState = serverManager?.getState();
  const discoveredServerUrl = serverState?.wsUrl;
  if (app.isPackaged && !discoveredServerUrl) {
    log.error('Cannot start recording: managed server URL unavailable', {
      serverStatus: serverState?.status,
      managed: serverState?.managed,
    });
    return;
  }

  isRecording = true;
  recordingSource = source;
  latestTranscription = null;
  updateConnectionState({ status: 'connecting' });
  updateRecordingState({ state: 'processing', isRecording: true });

  // Position and show overlay
  positionOverlayOnActiveDisplay(overlayWindow);
  showOverlay(overlayWindow);

  // Initialize transcription service
  // Only use silence timeout in toggle mode; in hold mode use a very long timeout (user releases key to stop)
  const isHoldMode = getSetting('holdToTalk');
  const silenceTimeout = isHoldMode ? 300 : getSetting('silenceTimeout'); // 5 min fallback for hold mode
  const settings = getSettings();
  const hotwords = settings.hotwordsEnabled ? buildHotwordsPrompt(settings.hotwordsCsl) : undefined;

  // In development, allow settings fallback for manually started external servers.
  const serverUrl = discoveredServerUrl ?? getSetting('serverUrl');

  const service = new TranscriptionService(
    serverUrl,
    silenceTimeout,
    overlayWindow,
    hotwords
  );
  transcriptionService = service;

  service.onRecordingState((payload) => {
    if (transcriptionService !== service) return;
    updateRecordingState(payload);
  });

  service.onConnectionState((payload) => {
    if (transcriptionService !== service) return;
    updateConnectionState(payload);
  });

  service.onTranscription((payload) => {
    if (transcriptionService !== service) return;
    updateTranscription(payload);
  });

  // Set up transcription callbacks
  service.onFinal(async (frame: TextFrameFinal) => {
    if (source !== 'normal') {
      return;
    }

    if (frame.text) {
      // Process through pipeline (post-processing, clipboard, paste, history)
      const result = await processFinalTranscription(frame, getSettings(), historyService);

      // Push new entry to main window if visible
      if (mainWindow && mainWindow.isVisible()) {
        mainWindow.webContents.send(IPC_CHANNELS.HISTORY_NEW_ENTRY, result.entryWithGroup);
      }
    }
  });

  service.onClose(() => {
    if (transcriptionService !== service) return;

    isRecording = false;
    isStopping = false;
    transcriptionService = null;
    latestTranscription = null;
    recordingSource = null;

    if (overlayWindow) {
      hideOverlay(overlayWindow);
    }
  });

  // Connect to server
  try {
    await service.connect();
    // Tell overlay to start audio capture with selected device
    const deviceId = getSetting('selectedDeviceId');
    overlayWindow.webContents.send(IPC_CHANNELS.COMMAND_START_RECORDING, deviceId);
  } catch (error) {
    log.error('Failed to connect to transcription server', { error: error as Error });
    stopRecording();
  }
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  isStopping = true;

  // Tell overlay to stop audio capture
  overlayWindow?.webContents.send(IPC_CHANNELS.COMMAND_STOP_RECORDING);

  // Send stop to server
  transcriptionService?.stop();
  updateRecordingState({ state: 'idle', isRecording: false });
  updateConnectionState({ status: 'disconnected' });

  // Hide overlay after brief delay to show final state
  setTimeout(() => {
    if (overlayWindow) {
      hideOverlay(overlayWindow);
    }
  }, 500);
}

// Handle audio data from overlay renderer
function setupAudioHandler() {
  ipcMain.on('audio:data', (_event, audioData: ArrayBuffer) => {
    if (transcriptionService && isRecording) {
      transcriptionService.sendAudioBuffer(audioData);
    }
  });
}

// Handle main window controls
function setupMainWindowHandlers() {
  ipcMain.on(IPC_CHANNELS.MAIN_WINDOW_CLOSE, () => {
    mainWindow?.hide();
  });

  ipcMain.on(IPC_CHANNELS.MAIN_WINDOW_MINIMIZE, () => {
    mainWindow?.minimize();
  });

  ipcMain.on(IPC_CHANNELS.MAIN_WINDOW_MAXIMIZE, () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_GET_STATE, () => {
    return getRecordingDebugState();
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_START, async () => {
    if (isRecording && recordingSource !== 'lab') {
      throw new Error('Cannot start Lab session while regular recording is active');
    }
    if (isStopping) {
      throw new Error('Recording is stopping, please wait a moment');
    }
    await startRecording('lab');
    return getRecordingDebugState();
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    await stopRecording();
    return getRecordingDebugState();
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_TOGGLE, async () => {
    if (isStopping) {
      throw new Error('Recording is stopping, please wait a moment');
    }
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording('lab');
    }
    return getRecordingDebugState();
  });
}

// Handle display configuration changes (monitors added/removed/changed)
function setupDisplayChangeHandlers() {
  screen.on('display-removed', (_event, oldDisplay) => {
    log.info('Display removed', { displayId: oldDisplay.id, bounds: oldDisplay.bounds });
    if (isRecording && overlayWindow) {
      // Reposition overlay to ensure it's on a valid display
      positionOverlayOnActiveDisplay(overlayWindow);
      log.debug('Repositioned overlay after display removal');
    }
  });

  screen.on('display-added', (_event, newDisplay) => {
    log.info('Display added', { displayId: newDisplay.id, bounds: newDisplay.bounds });
    // No action needed - overlay will position correctly on next show
  });

  screen.on('display-metrics-changed', (_event, display, changedMetrics) => {
    log.info('Display metrics changed', { displayId: display.id, changedMetrics });
    if (isRecording && overlayWindow) {
      // Reposition overlay in case work area changed
      positionOverlayOnActiveDisplay(overlayWindow);
      log.debug('Repositioned overlay after display metrics change');
    }
  });
}

app.whenReady().then(async () => {
  log.info('Murmur starting');

  // Initialize history service early
  historyService = new HistoryService();
  historyService.initialize();
  log.info('History service initialized');

  // Initialize server manager
  serverManager = new ServerManager();
  log.info('Server manager initialized');

  // Set up IPC handlers before creating windows (renderers call handlers on mount)
  setupIpcHandlers(historyService, serverManager);

  // Create main window (respects startMinimized setting)
  const startMinimized = getSetting('startMinimized');
  mainWindow = await createMainWindow({ startMinimized });
  log.info('Main window created', { startMinimized });

  // Give server manager reference to main window for state broadcasts
  serverManager.setMainWindow(mainWindow);

  // Create overlay window (pre-warmed, hidden)
  overlayWindow = await createOverlayWindow();
  log.info('Overlay window created');

  // Open DevTools in development
  if (['dev', 'development'].includes(process.env.NODE_ENV?.toLowerCase() ?? '')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  setupAudioHandler();
  setupMainWindowHandlers();
  setupDisplayChangeHandlers();

  // Set up global hotkey (supports hold-to-talk and toggle modes)
  setupHotkeyService(
    () => {
      // Key down handler
      if (getSetting('holdToTalk')) {
        // Hold mode: start recording on key down
        log.info('Recording started (hold mode)');
        startRecording('normal');
      } else {
        // Toggle mode: toggle recording on key down
        if (isRecording) {
          log.info('Recording stopped (toggle mode)');
          stopRecording();
        } else {
          log.info('Recording started (toggle mode)');
          startRecording('normal');
        }
      }
    },
    () => {
      // Key up handler
      if (getSetting('holdToTalk')) {
        // Hold mode: stop recording on key up
        log.info('Recording stopped (hold mode)');
        stopRecording();
      }
      // Toggle mode: do nothing on key up
    }
  );

  // Set up system tray with main window reference for show/focus
  setupTray(() => {
    if (mainWindow) {
      showMainWindow(mainWindow);
    }
  });

  // Handle server lifecycle based on environment
  // Use app.isPackaged (true when running from asar/built app, false in dev)
  const isDev = !app.isPackaged;

  if (isDev) {
    // Development mode: just detect existing server, don't spawn
    log.info('Development mode: detecting existing server');
    await serverManager.detectExisting();
  } else {
    // Production mode: auto-start if enabled
    if (getSetting('serverAutoStart')) {
      log.info('Production mode: auto-starting server');
      await serverManager.start();
    } else {
      log.info('Production mode: server auto-start disabled, detecting existing');
      await serverManager.detectExisting();
    }
  }

  log.info('Murmur ready');

  // Handle app lifecycle
  app.on('window-all-closed', () => {
    // Don't quit - we live in the tray
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlayWindow().then(win => {
        overlayWindow = win;
      });
    }
  });
});

app.on('will-quit', async (event) => {
  // Prevent immediate quit to allow async cleanup
  event.preventDefault();

  // Cleanup
  transcriptionService?.stop();
  historyService?.close();
  await serverManager?.cleanup();

  // Now actually quit
  app.exit(0);
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}
