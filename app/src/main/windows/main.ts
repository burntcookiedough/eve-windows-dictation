import { app, BrowserWindow, screen } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getMainWindowBounds, setMainWindowBounds, getSettings } from '../services/settings.js';
import { getMurmurIcon } from '../services/app-icon.js';
import { fitMainWindowBounds } from './main-window-bounds.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = ['dev', 'development'].includes(process.env.NODE_ENV?.toLowerCase() ?? '');
const devServerOrigin = `http://localhost:${process.env.MURMUR_DEV_PORT ?? '5173'}`;

let isQuitting = false;
let quitFlushPending = false;
let mainWindowForQuit: BrowserWindow | null = null;

// Wait for deferred History deletes before the app closes its database services.
app.on('before-quit', (event) => {
  if (isQuitting) return;
  const window = mainWindowForQuit;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    isQuitting = true;
    return;
  }

  event.preventDefault();
  if (quitFlushPending) return;
  quitFlushPending = true;

  void window.webContents
    .executeJavaScript('window.__flushDeferredHistoryDeletesOnQuit?.()')
    .then(() => {
      isQuitting = true;
      app.quit();
    })
    .catch((error: unknown) => {
      console.error('Failed to flush History deletes during app shutdown:', error);
      quitFlushPending = false;
      if (!window.isDestroyed()) showMainWindow(window);
    });
});

export interface CreateMainWindowOptions {
  startMinimized?: boolean;
}

export function applyMainWindowAppearance(window: BrowserWindow, appearance: 'dark' | 'light'): void {
  const light = appearance === 'light';
  window.setBackgroundColor(light ? '#f4f4f2' : '#0b0b0b');
  window.setTitleBarOverlay({
    color: light ? '#f4f4f2' : '#0b0b0b',
    symbolColor: light ? '#141414' : '#ececec',
    height: 40,
  });
}

export async function createMainWindow(options: CreateMainWindowOptions = {}): Promise<BrowserWindow> {
  const preloadPath = join(__dirname, 'preload/main.js');
  const lightAppearance = getSettings().appearance === 'light';

  // Saved dimensions are intentionally ignored so past user resizing cannot change the fixed window size.
  const savedBounds = getMainWindowBounds();
  const getDisplayWorkAreas = () => screen.getAllDisplays().map(({ id, workArea }) => ({ id, workArea }));
  const fittedBounds = fitMainWindowBounds(
    savedBounds,
    getDisplayWorkAreas(),
    screen.getPrimaryDisplay().id
  );

  const mainWindow = new BrowserWindow({
    ...fittedBounds,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: lightAppearance ? '#f4f4f2' : '#0b0b0b',
      symbolColor: lightAppearance ? '#141414' : '#ececec',
      height: 40,
    },
    transparent: false,
    backgroundColor: lightAppearance ? '#f4f4f2' : '#0b0b0b',
    icon: getMurmurIcon('icon.ico'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindowForQuit = mainWindow;
  mainWindow.setBounds(fittedBounds);

  // Save window bounds when moved or resized
  const saveBounds = () => {
    if (!mainWindow.isMinimized()) {
      setMainWindowBounds(mainWindow.getBounds());
    }
  };

  const refitBounds = () => {
    if (mainWindow.isDestroyed()) {
      return;
    }

    const bounds = mainWindow.getBounds();
    const nextBounds = fitMainWindowBounds(
      bounds,
      getDisplayWorkAreas(),
      screen.getPrimaryDisplay().id,
      bounds
    );
    if (
      bounds.x !== nextBounds.x ||
      bounds.y !== nextBounds.y ||
      Math.abs(bounds.width - nextBounds.width) > 1 ||
      Math.abs(bounds.height - nextBounds.height) > 1
    ) {
      mainWindow.setBounds(nextBounds);
    }
  };

  const refitOnDisplayChange = () => {
    refitBounds();
    saveBounds();
  };
  mainWindow.on('moved', () => {
    refitBounds();
    saveBounds();
  });
  mainWindow.on('resized', saveBounds);
  screen.on('display-added', refitOnDisplayChange);
  screen.on('display-removed', refitOnDisplayChange);
  screen.on('display-metrics-changed', refitOnDisplayChange);
  mainWindow.once('closed', () => {
    if (mainWindowForQuit === mainWindow) mainWindowForQuit = null;
    screen.off('display-added', refitOnDisplayChange);
    screen.off('display-removed', refitOnDisplayChange);
    screen.off('display-metrics-changed', refitOnDisplayChange);
  });
  setMainWindowBounds(mainWindow.getBounds());

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
