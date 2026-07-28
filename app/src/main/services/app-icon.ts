import { app, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function iconCandidates(fileName: string): string[] {
  return [
    join(process.resourcesPath, fileName),
    join(process.resourcesPath, 'resources', fileName),
    join(app.getAppPath(), 'resources', fileName),
  ];
}

export function getMurmurIcon(fileName = 'icon.ico'): Electron.NativeImage | undefined {
  for (const iconPath of iconCandidates(fileName)) {
    if (!existsSync(iconPath)) continue;
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return undefined;
}

export type TrayIconVariant = 'light' | 'dark' | 'high-contrast';

export function getMurmurTrayIcon(
  variant: TrayIconVariant = 'dark'
): Electron.NativeImage | undefined {
  const icon =
    getMurmurIcon(`tray-${variant}.ico`) ??
    getMurmurIcon('icon.ico') ??
    getMurmurIcon('icon.png');
  if (!icon || icon.isEmpty()) {
    return undefined;
  }

  return icon;
}
