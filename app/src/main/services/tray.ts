import { Tray, Menu, app, nativeImage } from 'electron';
import { join } from 'path';

let tray: Tray | null = null;

function getTrayIcon(): Electron.NativeImage {
  const candidates = [
    join(app.getAppPath(), 'resources', 'icon.png'),
    join(process.resourcesPath, 'icon.png'),
  ];

  for (const iconPath of candidates) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon.resize({ width: 16, height: 16 });
    }
  }

  return createPlaceholderIcon();
}

export function setupTray(onShowMainWindow?: () => void): void {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('Murmur - Press Ctrl+Win to dictate');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Murmur',
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

function createPlaceholderIcon(): Electron.NativeImage {
  // Create a simple 16x16 gray icon
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);

  for (let i = 0; i < size * size; i++) {
    const offset = i * 4;
    buffer[offset] = 100;     // R
    buffer[offset + 1] = 100; // G
    buffer[offset + 2] = 100; // B
    buffer[offset + 3] = 255; // A
  }

  return nativeImage.createFromBuffer(buffer, {
    width: size,
    height: size,
  });
}

export function updateTrayState(state: 'idle' | 'recording' | 'error'): void {
  if (!tray) return;

  const tooltips: Record<typeof state, string> = {
    idle: 'Murmur - Press Ctrl+Win to dictate',
    recording: 'Murmur - Recording...',
    error: 'Murmur - Error occurred',
  };

  tray.setToolTip(tooltips[state]);
}
