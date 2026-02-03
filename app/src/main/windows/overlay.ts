import { BrowserWindow, screen } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OVERLAY_CONFIG } from '../../shared/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Overlay');
const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = ['dev', 'development'].includes(process.env.NODE_ENV?.toLowerCase() ?? '');

export async function createOverlayWindow(): Promise<BrowserWindow> {
  // __dirname at runtime is dist/main/, preload is at dist/main/preload/
  const preloadPath = join(__dirname, 'preload/overlay.js');
  log.debug('Creating overlay window', { preloadPath });

  const overlay = new BrowserWindow({
    width: OVERLAY_CONFIG.WIDTH,
    height: OVERLAY_CONFIG.HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    thickFrame: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Prevent the window from being focusable
  overlay.setIgnoreMouseEvents(true);

  // Load the overlay page
  if (isDev) {
    await overlay.loadURL('http://localhost:5173/overlay/index.html');
  } else {
    await overlay.loadFile(join(__dirname, '../../renderer/overlay/index.html'));
  }

  return overlay;
}

export function positionOverlayOnActiveDisplay(overlay: BrowserWindow): void {
  // Get the display where the cursor is (proxy for active window)
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { workArea } = display;

  // Position at bottom-center of the work area
  const x = workArea.x + Math.round((workArea.width - OVERLAY_CONFIG.WIDTH) / 2);
  const y = workArea.y + workArea.height - OVERLAY_CONFIG.HEIGHT - OVERLAY_CONFIG.BOTTOM_MARGIN;

  overlay.setPosition(x, y);
}

export function showOverlay(overlay: BrowserWindow): void {
  overlay.showInactive();
}

export function hideOverlay(overlay: BrowserWindow): void {
  overlay.hide();
}
