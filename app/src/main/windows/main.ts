import { app, BrowserWindow, nativeImage, screen } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MAIN_WINDOW_CONFIG } from '../../shared/constants.js';
import { getMainWindowBounds, setMainWindowBounds } from '../services/settings.js';
import type { WindowBounds } from '../../shared/types.js';

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

/**
 * Check if the saved bounds are visible on any connected display.
 * Returns true if at least part of the window would be visible.
 */
function areBoundsOnScreen(bounds: WindowBounds): boolean {
  const displays = screen.getAllDisplays();

  // Check if at least a portion of the window is visible on any display
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;

    // Check if the bounds overlap with this display
    const overlapsX = bounds.x < x + width && bounds.x + bounds.width > x;
    const overlapsY = bounds.y < y + height && bounds.y + bounds.height > y;

    if (overlapsX && overlapsY) {
      return true;
    }
  }

  return false;
}

export interface CreateMainWindowOptions {
  startMinimized?: boolean;
}

export async function createMainWindow(options: CreateMainWindowOptions = {}): Promise<BrowserWindow> {
  const preloadPath = join(__dirname, 'preload/main.js');

  // Restore saved window bounds if valid, otherwise use defaults
  const savedBounds = getMainWindowBounds();
  const useSavedBounds = savedBounds && areBoundsOnScreen(savedBounds);

  const mainWindow = new BrowserWindow({
    width: useSavedBounds ? savedBounds.width : MAIN_WINDOW_CONFIG.WIDTH,
    height: useSavedBounds ? savedBounds.height : MAIN_WINDOW_CONFIG.HEIGHT,
    x: useSavedBounds ? savedBounds.x : undefined,
    y: useSavedBounds ? savedBounds.y : undefined,
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

  // Save window bounds when moved or resized
  const saveBounds = () => {
    if (!mainWindow.isMinimized()) {
      setMainWindowBounds(mainWindow.getBounds());
    }
  };
  mainWindow.on('moved', saveBounds);
  mainWindow.on('resized', saveBounds);

  // Show when ready to avoid visual flash (unless starting minimized)
  if (!options.startMinimized) {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
    });
  }

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
