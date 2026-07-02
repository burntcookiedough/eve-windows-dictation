import { BrowserWindow, screen } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OVERLAY_CONFIG } from '../../shared/constants.js';
import type { DictationSessionMode } from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';
import { calculateOverlayBounds } from './overlay-bounds.js';

const log = createLogger('Overlay');
const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = ['dev', 'development'].includes(process.env.NODE_ENV?.toLowerCase() ?? '');
const devServerOrigin = `http://localhost:${process.env.MURMUR_DEV_PORT ?? '5173'}`;

export async function createOverlayWindow(): Promise<BrowserWindow> {
  // __dirname at runtime is dist/main/, preload is at dist/main/preload/
  const preloadPath = join(__dirname, 'preload/overlay.js');
  log.debug('Creating overlay window', { preloadPath });

  const overlay = new BrowserWindow({
    width: OVERLAY_CONFIG.QUICK_WIDTH,
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

function getOverlayWidth(mode: DictationSessionMode): number {
  return mode === 'long' ? OVERLAY_CONFIG.LONG_WIDTH : OVERLAY_CONFIG.QUICK_WIDTH;
}

export function positionOverlayOnActiveDisplay(
  overlay: BrowserWindow,
  mode: DictationSessionMode = 'quick'
): void {
  // Get the display where the cursor is (proxy for active window)
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { bounds: displayBounds, workArea } = display;

  const preferredWidth = getOverlayWidth(mode);
  const bounds = calculateOverlayBounds(
    displayBounds,
    workArea,
    preferredWidth,
    OVERLAY_CONFIG.HEIGHT,
    OVERLAY_CONFIG.BOTTOM_MARGIN
  );
  overlay.setBounds(bounds);

  log.debug('Positioning overlay', {
    cursor: cursorPoint,
    displayId: display.id,
    displayBounds,
    workArea,
    mode,
    position: { x: bounds.x, y: bounds.y },
    size: { width: bounds.width, height: bounds.height },
  });
}

export function showOverlay(overlay: BrowserWindow): void {
  overlay.showInactive();
  overlay.setAlwaysOnTop(false);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.moveTop();
}

export function hideOverlay(overlay: BrowserWindow): void {
  overlay.hide();
}
