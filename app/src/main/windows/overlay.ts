import { BrowserWindow, screen } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OVERLAY_CONFIG } from '../../shared/constants.js';
import { createLogger } from '../lib/logger.js';
import { calculateOverlayBounds } from './overlay-bounds.js';

const log = createLogger('Overlay');
const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = ['dev', 'development'].includes(process.env.NODE_ENV?.toLowerCase() ?? '');
const devServerOrigin = `http://localhost:${process.env.MURMUR_DEV_PORT ?? '5173'}`;
const TOPMOST_GUARD_MS = 1000;
let topmostGuard: ReturnType<typeof setInterval> | null = null;

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
    await overlay.loadURL(`${devServerOrigin}/overlay/index.html`);
  } else {
    await overlay.loadFile(join(__dirname, '../renderer/overlay/index.html'));
  }

  return overlay;
}

export function positionOverlayOnActiveDisplay(overlay: BrowserWindow): void {
  // Get the display where the cursor is (proxy for active window)
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { bounds: displayBounds, workArea } = display;

  const bounds = calculateOverlayBounds(
    displayBounds,
    workArea,
    OVERLAY_CONFIG.WIDTH,
    OVERLAY_CONFIG.HEIGHT,
    OVERLAY_CONFIG.BOTTOM_MARGIN
  );
  overlay.setBounds(bounds);

  log.debug('Positioning overlay', {
    cursor: cursorPoint,
    displayId: display.id,
    displayBounds,
    workArea,
    position: { x: bounds.x, y: bounds.y },
    size: { width: bounds.width, height: bounds.height },
  });
}

function stopTopmostGuard(): void {
  if (topmostGuard) {
    clearInterval(topmostGuard);
    topmostGuard = null;
  }
}

export function showOverlay(overlay: BrowserWindow): void {
  overlay.showInactive();
  overlay.setAlwaysOnTop(false);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.moveTop();

  // Other always-on-top windows opened mid-dictation would otherwise cover the
  // pill, so keep reclaiming the top slot for as long as it is showing.
  stopTopmostGuard();
  topmostGuard = setInterval(() => {
    if (overlay.isDestroyed()) {
      stopTopmostGuard();
      return;
    }
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.moveTop();
  }, TOPMOST_GUARD_MS);
}

export function hideOverlay(overlay: BrowserWindow): void {
  stopTopmostGuard();
  overlay.hide();
}
