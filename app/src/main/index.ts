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
import { getForegroundWindowHandle } from './services/clipboard.js';
import { getSettings, getSetting } from './services/settings.js';
import type { TextFrameFinal } from '../shared/protocol.js';
import { IPC_CHANNELS } from '../shared/constants.js';
import { buildHotwordsPrompt } from '../shared/hotwords.js';
import type {
  RecordingStatePayload,
  ConnectionStatePayload,
  TranscriptionPayload,
  RecordingDebugState,
  RecordingStatusPayload,
  DictationSessionMode,
  AudioCaptureErrorPayload,
} from '../shared/types.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('App');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.murmur.app');
}

let overlayWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let transcriptionService: TranscriptionService | null = null;
let historyService: HistoryService | null = null;
let serverManager: ServerManager | null = null;
let isRecording = false;
let recordingSource: 'lab' | 'normal' | null = null;
let recordingSessionMode: DictationSessionMode = 'quick';
let isStopping = false;
let startLongAfterStop = false;
let currentRecordingState: RecordingStatePayload = { state: 'idle', isRecording: false, mode: 'quick' };
let currentConnectionState: ConnectionStatePayload = { status: 'disconnected' };
let latestTranscription: TranscriptionPayload | null = null;
let latestStatus: RecordingStatusPayload | null = null;
let recordingTerminalOverride: 'error' | null = null;
let overlaySessionGeneration = 0;
let overlayExitTimer: ReturnType<typeof setTimeout> | null = null;
let overlayHideTimer: ReturnType<typeof setTimeout> | null = null;

const OVERLAY_SUCCESS_DWELL_MS = 900;
const OVERLAY_ERROR_DWELL_MS = 2200;
const OVERLAY_EXIT_ANIMATION_MS = 200;

function clearOverlayDismissTimers(): void {
  if (overlayExitTimer) {
    clearTimeout(overlayExitTimer);
    overlayExitTimer = null;
  }
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
}

function beginOverlaySession(): number {
  overlaySessionGeneration += 1;
  clearOverlayDismissTimers();
  return overlaySessionGeneration;
}

function sendOverlayRecordingState(payload: RecordingStatePayload): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(IPC_CHANNELS.STATE_RECORDING, payload);
  }
  updateRecordingState(payload);
}

function scheduleOverlayDismiss(
  generation: number,
  mode: DictationSessionMode,
  terminalState: RecordingStatePayload['state']
): void {
  clearOverlayDismissTimers();
  const dwellMs = terminalState === 'error'
    ? OVERLAY_ERROR_DWELL_MS
    : terminalState === 'success'
      ? OVERLAY_SUCCESS_DWELL_MS
      : 0;

  overlayExitTimer = setTimeout(() => {
    overlayExitTimer = null;
    if (generation !== overlaySessionGeneration || isRecording) return;

    sendOverlayRecordingState({ state: 'idle', isRecording: false, mode });
    overlayHideTimer = setTimeout(() => {
      overlayHideTimer = null;
      if (generation !== overlaySessionGeneration || isRecording) return;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        hideOverlay(overlayWindow);
      }
    }, OVERLAY_EXIT_ANIMATION_MS);
  }, dwellMs);
}

function showTransientOverlayError(message: string, mode: DictationSessionMode): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const generation = beginOverlaySession();
  positionOverlayOnActiveDisplay(overlayWindow, mode);
  showOverlay(overlayWindow);
  overlayWindow.webContents.send(IPC_CHANNELS.STATE_WARNING, {
    code: 'engine_not_ready',
    message,
  });
  sendOverlayRecordingState({ state: 'error', isRecording: false, mode });
  scheduleOverlayDismiss(generation, mode, 'error');
}
let currentPasteTargetWindowHandlePromise: Promise<number | null> | null = null;

function broadcastLabState<T>(channel: string, payload: T): void {
  if (recordingSource === 'lab' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function updateRecordingState(payload: RecordingStatePayload): void {
  const nextPayload = { ...payload, mode: payload.mode ?? recordingSessionMode };
  currentRecordingState = nextPayload;
  broadcastLabState(IPC_CHANNELS.STATE_RECORDING, nextPayload);
}

function updateConnectionState(payload: ConnectionStatePayload): void {
  currentConnectionState = payload;
  broadcastLabState(IPC_CHANNELS.STATE_CONNECTION, payload);
}

function updateTranscription(payload: TranscriptionPayload): void {
  latestTranscription = payload;
  broadcastLabState(IPC_CHANNELS.STATE_TRANSCRIPTION, payload);
}

function updateStatus(payload: RecordingStatusPayload): void {
  latestStatus = payload;
  broadcastLabState(IPC_CHANNELS.STATE_STATUS, payload);
}

function getRecordingDebugState(): RecordingDebugState {
  if (recordingSource !== 'lab') {
    return {
      recording: { state: 'idle', isRecording: false, mode: 'quick' },
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

async function startRecording(source: 'lab' | 'normal', sessionMode: DictationSessionMode = 'quick') {
  if (isRecording || isStopping || !overlayWindow) return;

  const useExternalServer = getSetting('useExternalServer');

  // In packaged builds, require managed server discovery unless external mode is enabled.
  const serverState = serverManager?.getState();
  const discoveredServerUrl = serverState?.wsUrl;
  if (app.isPackaged && !useExternalServer && !discoveredServerUrl) {
    log.error('Cannot start recording: managed server URL unavailable', {
      serverStatus: serverState?.status,
      managed: serverState?.managed,
    });
    return;
  }

  if (
    app.isPackaged &&
    !useExternalServer &&
    serverState?.engineStatus?.status !== 'ready'
  ) {
    const engineStatus = serverState?.engineStatus;
    const message = engineStatus?.status === 'error'
      ? (engineStatus.message ?? 'The transcription engine failed to load. Open Server settings for details.')
      : 'The speech model is still loading. Keep Murmur open and try again when the Server status is ready.';
    log.warn('Cannot start recording: transcription engine is not ready', {
      engine: engineStatus?.current,
      engineStatus: engineStatus?.status ?? 'unknown',
      message: engineStatus?.message,
    });
    showTransientOverlayError(message, sessionMode);
    return;
  }

  const sessionGeneration = beginOverlaySession();

  isRecording = true;
  recordingTerminalOverride = null;
  recordingSource = source;
  recordingSessionMode = sessionMode;
  currentPasteTargetWindowHandlePromise = source === 'normal'
    ? getForegroundWindowHandle()
    : null;
  latestTranscription = null;
  latestStatus = null;
  updateConnectionState({ status: 'connecting' });
  updateRecordingState({ state: 'processing', isRecording: true, mode: sessionMode });

  // Position and show overlay
  positionOverlayOnActiveDisplay(overlayWindow, sessionMode);
  showOverlay(overlayWindow);

  // Initialize transcription service
  // Only use silence timeout in toggle mode; in hold mode use a very long timeout (user releases key to stop)
  const isHoldMode = getSetting('holdToTalk');
  const silenceTimeout = sessionMode === 'quick' && isHoldMode
    ? 300
    : getSetting('silenceTimeout');
  const settings = getSettings();
  const hotwords = settings.hotwordsEnabled ? buildHotwordsPrompt(settings.hotwordsCsl) : undefined;

  const serverUrl = useExternalServer
    ? getSetting('serverUrl')
    : (discoveredServerUrl ?? getSetting('serverUrl'));

  const service = new TranscriptionService(
    serverUrl,
    silenceTimeout,
    overlayWindow,
    hotwords,
    sessionMode
  );
  transcriptionService = service;
  const serviceSessionMode = sessionMode;
  const servicePasteTargetWindowHandlePromise = currentPasteTargetWindowHandlePromise;

  service.onRecordingState((payload) => {
    if (transcriptionService !== service) return;
    if (recordingTerminalOverride) return;
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

  service.onStatus((payload) => {
    if (transcriptionService !== service) return;
    updateStatus(payload);
  });

  // Set up transcription callbacks
  service.onFinal(async (frame: TextFrameFinal) => {
    if (transcriptionService !== service) {
      return;
    }

    if (source !== 'normal') {
      return;
    }

    if (frame.text) {
      const pasteTargetWindowHandle = await servicePasteTargetWindowHandlePromise
        ?.catch(() => null) ?? null;

      // Process through pipeline (post-processing, clipboard, paste, history)
      const result = await processFinalTranscription(
        frame,
        getSettings(),
        historyService,
        serviceSessionMode,
        pasteTargetWindowHandle
      );

      // Push new entry to main window if visible
      if (mainWindow && mainWindow.isVisible()) {
        mainWindow.webContents.send(IPC_CHANNELS.HISTORY_NEW_ENTRY, result.entryWithGroup);
      }
    }
  });

  service.onClose(() => {
    if (transcriptionService !== service) return;
    const shouldStartLongAfterStop = startLongAfterStop;
    const closedSessionMode = recordingSessionMode;
    const terminalState = recordingTerminalOverride ?? currentRecordingState.state;

    // A server-initiated close must stop the renderer's microphone capture too.
    overlayWindow?.webContents.send(IPC_CHANNELS.COMMAND_STOP_RECORDING);

    // End Lab state immediately while allowing the overlay to dwell on its
    // success/error state before its renderer exit transition and native hide.
    updateRecordingState({ state: 'idle', isRecording: false, mode: closedSessionMode });

    isRecording = false;
    isStopping = false;
    transcriptionService = null;
    latestTranscription = null;
    latestStatus = null;
    recordingSource = null;
    recordingSessionMode = 'quick';
    recordingTerminalOverride = null;
    currentPasteTargetWindowHandlePromise = null;

    scheduleOverlayDismiss(sessionGeneration, closedSessionMode, terminalState);

    if (shouldStartLongAfterStop) {
      startLongAfterStop = false;
      void startRecording('normal', 'long');
    }
  });

  // Connect to server
  try {
    await service.connect();
    if (transcriptionService !== service || !isRecording) {
      return;
    }
    // Tell overlay to start audio capture with selected device
    const deviceId = getSetting('selectedDeviceId');
    overlayWindow.webContents.send(IPC_CHANNELS.COMMAND_START_RECORDING, deviceId);
  } catch (error) {
    if (transcriptionService !== service) {
      return;
    }
    log.error('Failed to connect to transcription server', { error: error as Error });
    recordingTerminalOverride = 'error';
    await stopRecording();
    sendOverlayRecordingState({ state: 'error', isRecording: false, mode: sessionMode });
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
  updateRecordingState({ state: 'processing', isRecording: true, mode: recordingSessionMode });
}

function queueLongRecordingAfterStop(): void {
  startLongAfterStop = true;
  if (!isRecording && !isStopping) {
    startLongAfterStop = false;
    void startRecording('normal', 'long');
  }
}

function toggleLongRecording(): void {
  if (isRecording && recordingSessionMode === 'long') {
    log.info('Long dictation stopped');
    startLongAfterStop = false;
    stopRecording();
  } else if (isRecording || isStopping) {
    log.info('Long dictation queued after quick dictation stop');
    queueLongRecordingAfterStop();
    if (isRecording) {
      stopRecording();
    }
  } else {
    log.info('Long dictation started');
    startRecording('normal', 'long');
  }
}

// Handle audio data from overlay renderer
function setupAudioHandler() {
  ipcMain.on('audio:data', (event, audioData: ArrayBuffer) => {
    if (
      !overlayWindow ||
      overlayWindow.isDestroyed() ||
      event.sender.id !== overlayWindow.webContents.id ||
      !(audioData instanceof ArrayBuffer)
    ) {
      return;
    }
    if (transcriptionService && isRecording) {
      transcriptionService.sendAudioBuffer(audioData);
    }
  });

  ipcMain.on(
    IPC_CHANNELS.AUDIO_CAPTURE_ERROR,
    (event, payload: AudioCaptureErrorPayload) => {
      if (
        !isRecording ||
        !overlayWindow ||
        overlayWindow.isDestroyed() ||
        event.sender.id !== overlayWindow.webContents.id ||
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.code !== 'string' ||
        typeof payload.message !== 'string' ||
        (payload.deviceId !== undefined && typeof payload.deviceId !== 'string')
      ) {
        return;
      }

      log.error('Audio capture failed', {
        code: payload.code,
        message: payload.message,
        deviceId: payload.deviceId,
      });

      const mode = recordingSessionMode;
      recordingTerminalOverride = 'error';
      overlayWindow.webContents.send(IPC_CHANNELS.STATE_WARNING, {
        code: `audio_capture_${payload.code}`,
        message: payload.message,
      });
      void stopRecording().then(() => {
        sendOverlayRecordingState({ state: 'error', isRecording: false, mode });
      });
    }
  );
}

// Handle main window controls
function setupMainWindowHandlers() {
  const isMainWindowSender = (senderId: number) =>
    !!mainWindow && !mainWindow.isDestroyed() && senderId === mainWindow.webContents.id;

  ipcMain.on(IPC_CHANNELS.MAIN_WINDOW_CLOSE, (event) => {
    if (!isMainWindowSender(event.sender.id)) return;
    mainWindow?.hide();
  });

  ipcMain.on(IPC_CHANNELS.MAIN_WINDOW_MINIMIZE, (event) => {
    if (!isMainWindowSender(event.sender.id)) return;
    mainWindow?.minimize();
  });

  ipcMain.on(IPC_CHANNELS.MAIN_WINDOW_MAXIMIZE, (event) => {
    if (!isMainWindowSender(event.sender.id)) return;
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_GET_STATE, (event) => {
    if (!isMainWindowSender(event.sender.id)) throw new Error('Unauthorized IPC sender');
    return getRecordingDebugState();
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_START, async (event) => {
    if (!isMainWindowSender(event.sender.id)) throw new Error('Unauthorized IPC sender');
    if (isRecording && recordingSource !== 'lab') {
      throw new Error('Cannot start Lab session while regular recording is active');
    }
    if (isStopping) {
      throw new Error('Recording is stopping, please wait a moment');
    }
    await startRecording('lab');
    return getRecordingDebugState();
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async (event) => {
    if (!isMainWindowSender(event.sender.id)) throw new Error('Unauthorized IPC sender');
    await stopRecording();
    return getRecordingDebugState();
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_TOGGLE, async (event) => {
    if (!isMainWindowSender(event.sender.id)) throw new Error('Unauthorized IPC sender');
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
      positionOverlayOnActiveDisplay(overlayWindow, recordingSessionMode);
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
      positionOverlayOnActiveDisplay(overlayWindow, recordingSessionMode);
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
  setupAudioHandler();
  setupMainWindowHandlers();
  setupDisplayChangeHandlers();

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
  // Set up global hotkey (supports hold-to-talk and toggle modes)
  setupHotkeyService({
    onHoldStart: () => {
      if (getSetting('holdToTalk')) {
        log.info('Quick dictation started (hold mode)');
        startRecording('normal', 'quick');
      } else if (isRecording) {
        log.info('Quick dictation stopped (toggle mode)');
        stopRecording();
      } else {
        log.info('Quick dictation started (toggle mode)');
        startRecording('normal', 'quick');
      }
    },
    onHoldEnd: () => {
      if (getSetting('holdToTalk') && recordingSessionMode === 'quick') {
        log.info('Quick dictation stopped (hold mode)');
        stopRecording();
      }
    },
    onDoubleTap: () => {
      log.info('Long dictation toggled (double-tap)');
      toggleLongRecording();
    },
    onLongShortcut: () => {
      log.info('Long dictation toggled (long hotkey)');
      toggleLongRecording();
    },
  });

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
  } else if (getSetting('useExternalServer')) {
    log.info('Production mode: using external server, skipping managed auto-start');
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
