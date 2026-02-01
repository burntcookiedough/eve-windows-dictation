import { app, BrowserWindow, ipcMain } from 'electron';
import { createOverlayWindow, showOverlay, hideOverlay, positionOverlayOnActiveDisplay } from './windows/overlay.js';
import { createMainWindow, showMainWindow } from './windows/main.js';
import { setupHotkeyService } from './services/hotkey.js';
import { setupTray } from './services/tray.js';
import { setupIpcHandlers } from './ipc/handlers.js';
import { TranscriptionService } from './services/transcription.js';
import { copyToClipboard, simulatePaste } from './services/clipboard.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { IPC_CHANNELS } from '../shared/constants.js';

let overlayWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let transcriptionService: TranscriptionService | null = null;
let isRecording = false;
let pendingPaste = false;

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
  transcriptionService = new TranscriptionService(
    DEFAULT_SETTINGS.serverUrl,
    DEFAULT_SETTINGS.silenceTimeout,
    overlayWindow
  );

  // Set up transcription callbacks
  transcriptionService.onFinal((text) => {
    if (text) {
      if (DEFAULT_SETTINGS.autoCopy) {
        copyToClipboard(text);
      }
      if (DEFAULT_SETTINGS.autoPaste) {
        pendingPaste = true;
      }
    }
  });

  transcriptionService.onClose(() => {
    stopRecording();
  });

  // Connect to server
  try {
    await transcriptionService.connect();
    // Tell overlay to start audio capture
    overlayWindow.webContents.send(IPC_CHANNELS.COMMAND_START_RECORDING);
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

    // Paste after overlay is hidden and focus returns to previous app
    if (pendingPaste) {
      pendingPaste = false;
      // Small delay to ensure focus has returned to the target window
      setTimeout(() => {
        simulatePaste().catch((err) => {
          console.error('Auto-paste failed:', err);
        });
      }, 100);
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

app.whenReady().then(async () => {
  log('Murmur starting...');

  // Create main window (shown on startup)
  mainWindow = await createMainWindow();
  log('Main window created');

  // Create overlay window (pre-warmed, hidden)
  overlayWindow = await createOverlayWindow();
  log('Overlay window created');

  // Open DevTools in development
  if (process.env.NODE_ENV !== 'production') {
    overlayWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Set up IPC handlers
  setupIpcHandlers();
  setupAudioHandler();

  // Set up global hotkey (hold-to-talk)
  setupHotkeyService(
    DEFAULT_SETTINGS.hotkey,
    () => {
      log('Recording started');
      startRecording();
    },
    () => {
      log('Recording stopped');
      stopRecording();
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
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}
