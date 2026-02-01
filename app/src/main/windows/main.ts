import { app, BrowserWindow, nativeImage } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MAIN_WINDOW_CONFIG } from '../../shared/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== 'production';

function getAppIcon(): Electron.NativeImage | undefined {
  const iconPath = join(app.getAppPath(), 'resources', 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

let isQuitting = false;

// Set up app quit handler once
app.on('before-quit', () => {
  isQuitting = true;
});

export async function createMainWindow(): Promise<BrowserWindow> {
  const preloadPath = join(__dirname, 'preload/main.js');

  const mainWindow = new BrowserWindow({
    width: MAIN_WINDOW_CONFIG.WIDTH,
    height: MAIN_WINDOW_CONFIG.HEIGHT,
    minWidth: MAIN_WINDOW_CONFIG.MIN_WIDTH,
    minHeight: MAIN_WINDOW_CONFIG.MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a0a',
    icon: getAppIcon(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Show when ready to avoid visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Hide on close unless app is quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Load the app page
  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173/app/index.html');
  } else {
    await mainWindow.loadFile(join(__dirname, '../../renderer/app/index.html'));
  }

  return mainWindow;
}

export function showMainWindow(mainWindow: BrowserWindow): void {
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

export function hideMainWindow(mainWindow: BrowserWindow): void {
  mainWindow.hide();
}
