import { Tray, Menu, app } from 'electron';
import { getMurmurTrayIcon } from './app-icon.js';

let tray: Tray | null = null;

function getTrayIcon(): Electron.NativeImage {
  const icon = getMurmurTrayIcon();
  if (!icon) {
    throw new Error('Eve tray icon resource is missing or invalid');
  }
  return icon;
}

export function setupTray(onShowMainWindow?: () => void): void {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('Eve - Press Ctrl+Win to dictate');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Eve',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => {
        onShowMainWindow?.();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Left-click also shows the main window
  tray.on('click', () => {
    onShowMainWindow?.();
  });
}

export function updateTrayState(state: 'idle' | 'recording' | 'error'): void {
  if (!tray) return;

  const tooltips: Record<typeof state, string> = {
    idle: 'Eve - Press Ctrl+Win to dictate',
    recording: 'Eve - Recording...',
    error: 'Eve - Error occurred',
  };

  tray.setToolTip(tooltips[state]);
}
