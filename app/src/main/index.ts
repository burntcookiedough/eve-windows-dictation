import { app, BrowserWindow, ipcMain } from 'electron';
import { createOverlayWindow, showOverlay, hideOverlay, positionOverlayOnActiveDisplay } from './windows/overlay.js';
import { createMainWindow, showMainWindow } from './windows/main.js';
import { setupHotkeyService } from './services/hotkey.js';
import { setupTray } from './services/tray.js';
import { setupIpcHandlers } from './ipc/handlers.js';
import { TranscriptionService } from './services/transcription.js';
import { HistoryService } from './services/history.js';
import { processFinalTranscription } from './services/pipeline.js';
import { getSettings, getSetting } from './services/settings.js';
import type { TextFrameFinal } from '../shared/protocol.js';
import { IPC_CHANNELS } from '../shared/constants.js';

let overlayWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let transcriptionService: TranscriptionService | null = null;
let historyService: HistoryService | null = null;
let isRecording = false;

function log(...args: unknown[]) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${ts}]`, ...args);
}

async function startRecording() {
  if (isRecording || !overlayWindow) return;
  isRecording = true;

  // Position and show overlay
  positionOverlayOnActiveDisplay(overlayWindow);
  showOverlay(overlayWindow);

  // Initialize transcription service
  // Only use silence timeout in toggle mode; in hold mode use a very long timeout (user releases key to stop)
  const isHoldMode = getSetting('holdToTalk');
  const silenceTimeout = isHoldMode ? 300 : getSetting('silenceTimeout'); // 5 min fallback for hold mode

  transcriptionService = new TranscriptionService(
    getSetting('serverUrl'),
    silenceTimeout,
    overlayWindow
  );

  // Set up transcription callbacks
  transcriptionService.onFinal(async (frame: TextFrameFinal) => {
    if (frame.text) {
      // Process through pipeline (post-processing, clipboard, paste, history)
      const result = await processFinalTranscription(frame, getSettings(), historyService);

      // Push new entry to main window if visible
      if (mainWindow && mainWindow.isVisible()) {
        mainWindow.webContents.send(IPC_CHANNELS.HISTORY_NEW_ENTRY, result.entryWithGroup);
      }
    }
  });

  transcriptionService.onClose(() => {
    stopRecording();
  });

  // Connect to server
  try {
    await transcriptionService.connect();
    // Tell overlay to start audio capture with selected device
    const deviceId = getSetting('selectedDeviceId');
    overlayWindow.webContents.send(IPC_CHANNELS.COMMAND_START_RECORDING, deviceId);
  } catch (error) {
    console.error('Failed to connect to transcription server:', error);
    stopRecording();
  }
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  // Tell overlay to stop audio capture
  overlayWindow?.webContents.send(IPC_CHANNELS.COMMAND_STOP_RECORDING);

  // Send stop to server
  transcriptionService?.stop();
  transcriptionService = null;

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
}

app.whenReady().then(async () => {
  log('Murmur starting...');

  // Initialize history service early
  historyService = new HistoryService();
  historyService.initialize();
  log('History service initialized');

  // Set up IPC handlers before creating windows (renderers call handlers on mount)
  setupIpcHandlers(historyService);

  // Create main window (shown on startup)
  mainWindow = await createMainWindow();
  log('Main window created');

  // Create overlay window (pre-warmed, hidden)
  overlayWindow = await createOverlayWindow();
  log('Overlay window created');

  // Open DevTools in development
  if (process.env.NODE_ENV !== 'production') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  setupAudioHandler();
  setupMainWindowHandlers();

  // Set up global hotkey (supports hold-to-talk and toggle modes)
  setupHotkeyService(
    () => {
      // Key down handler
      if (getSetting('holdToTalk')) {
        // Hold mode: start recording on key down
        log('Recording started (hold mode)');
        startRecording();
      } else {
        // Toggle mode: toggle recording on key down
        if (isRecording) {
          log('Recording stopped (toggle mode)');
          stopRecording();
        } else {
          log('Recording started (toggle mode)');
          startRecording();
        }
      }
    },
    () => {
      // Key up handler
      if (getSetting('holdToTalk')) {
        // Hold mode: stop recording on key up
        log('Recording stopped (hold mode)');
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
  log('Murmur ready!');

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

app.on('will-quit', () => {
  // Cleanup
  transcriptionService?.stop();
  historyService?.close();
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}
