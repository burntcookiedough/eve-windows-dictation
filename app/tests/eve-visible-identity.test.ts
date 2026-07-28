import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.resolve(import.meta.dir, '..');

const VISIBLE_PRODUCT_FILES = [
  'src/main/bootstrap.ts',
  'src/main/index.ts',
  'src/main/services/diagnostics-report.ts',
  'src/main/services/tray.ts',
  'src/renderer/app/components/TitleBar.svelte',
  'src/renderer/app/index.html',
  'src/renderer/app/views/SettingsView.svelte',
  'src/renderer/overlay/index.html',
  'src/shared/model-progress.ts',
];

describe('Eve visible identity', () => {
  test('keeps legacy branding out of active user-facing surfaces', () => {
    for (const relativePath of VISIBLE_PRODUCT_FILES) {
      const contents = readFileSync(path.join(APP_ROOT, relativePath), 'utf8');
      const withoutAllowedInternalNames = contents.replaceAll(
        'getMurmurTrayIcon',
        'getCompatibilityTrayIcon'
      );
      expect(withoutAllowedInternalNames).not.toContain('Murmur');
    }
  });

  test('uses an Eve-branded default export name', () => {
    const handlers = readFileSync(
      path.join(APP_ROOT, 'src/main/ipc/handlers.ts'),
      'utf8'
    );
    expect(handlers).toContain("defaultPath: 'eve-hotwords.csv'");
    expect(handlers).not.toContain("defaultPath: 'murmur-hotwords.csv'");
  });

  test('uses the cactus resource family across application and tray surfaces', () => {
    const appIcon = readFileSync(
      path.join(APP_ROOT, 'src/main/services/app-icon.ts'),
      'utf8'
    );
    const tray = readFileSync(
      path.join(APP_ROOT, 'src/main/services/tray.ts'),
      'utf8'
    );

    expect(appIcon).toContain('tray-${variant}.ico');
    expect(tray).toContain('nativeTheme.inForcedColorsMode');
    expect(tray).toContain('nativeTheme.shouldUseDarkColorsForSystemIntegratedUI');
    expect(tray).toContain("nativeTheme.on('updated', refreshTrayIcon)");
  });
});
