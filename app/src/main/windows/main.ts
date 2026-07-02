import { app, BrowserWindow, screen } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MAIN_WINDOW_CONFIG } from '../../shared/constants.js';
import { getMainWindowBounds, setMainWindowBounds } from '../services/settings.js';
import type { WindowBounds } from '../../shared/types.js';
import { getMurmurIcon } from '../services/app-icon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = ['dev', 'development'].includes(process.env.NODE_ENV?.toLowerCase() ?? '');
const devServerOrigin = `http://localhost:${process.env.MURMUR_DEV_PORT ?? '5173'}`;

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

function clampBoundsToDisplay(bounds: WindowBounds): WindowBounds {
  const { workArea } = screen.getDisplayMatching(bounds);
  const width = Math.min(
    Math.max(bounds.width, MAIN_WINDOW_CONFIG.MIN_WIDTH),
    workArea.width
  );
  const height = Math.min(
    Math.max(bounds.height, MAIN_WINDOW_CONFIG.MIN_HEIGHT),
    workArea.height
  );
  const x = Math.min(
    Math.max(bounds.x, workArea.x),
    workArea.x + workArea.width - width
  );
  const y = Math.min(
    Math.max(bounds.y, workArea.y),
    workArea.y + workArea.height - height
  );

  return { x, y, width, height };
}

export interface CreateMainWindowOptions {
  startMinimized?: boolean;
}

export async function createMainWindow(options: CreateMainWindowOptions = {}): Promise<BrowserWindow> {
  const preloadPath = join(__dirname, 'preload/main.js');

  // Restore saved window bounds if valid, otherwise use defaults
  const savedBounds = getMainWindowBounds();
  const useSavedBounds = savedBounds && areBoundsOnScreen(savedBounds);
  const restoredBounds = useSavedBounds ? clampBoundsToDisplay(savedBounds) : null;
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const displayWorkAreas = screen.getAllDisplays().map((display) => display.workArea);
  const defaultWidth = Math.min(MAIN_WINDOW_CONFIG.WIDTH, primaryWorkArea.width);
  const defaultHeight = Math.min(MAIN_WINDOW_CONFIG.HEIGHT, primaryWorkArea.height);
  const minWidth = Math.min(
    MAIN_WINDOW_CONFIG.MIN_WIDTH,
    ...displayWorkAreas.map((workArea) => workArea.width)
  );
  const minHeight = Math.min(
    MAIN_WINDOW_CONFIG.MIN_HEIGHT,
    ...displayWorkAreas.map((workArea) => workArea.height)
  );

  const mainWindow = new BrowserWindow({
    width: restoredBounds?.width ?? defaultWidth,
    height: restoredBounds?.height ?? defaultHeight,
    x: restoredBounds?.x,
    y: restoredBounds?.y,
    minWidth,
    minHeight,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a0a',
    icon: getMurmurIcon('icon.ico'),
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
    await mainWindow.loadURL(`${devServerOrigin}/app/index.html`);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/app/index.html'));
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
