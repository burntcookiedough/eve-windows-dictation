import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  applyLaunchOnBoot,
  LEGACY_LOGIN_ITEM_NAMES,
  LOGIN_ITEM_UNAVAILABLE,
  LOGIN_ITEM_UPDATE_FAILED,
  reconcileLegacyLoginItems,
  type LoginItemApp,
} from '../src/main/login-item-policy';
import { EVE_IDENTITY } from '../src/main/identity';

const EVE_APP_ID = EVE_IDENTITY.appId;
const EVE_EXE = String.raw`C:\Users\fixture\AppData\Local\Programs\murmur\Eve.exe`;
const LOCAL_APP_DATA = String.raw`C:\Users\fixture\AppData\Local`;
const LEGACY_EXE = path.win32.join(
  LOCAL_APP_DATA,
  'Programs',
  'murmur',
  'Murmur.exe'
);

interface FakeLoginItem {
  name: string;
  path: string;
  args: string[];
  scope: 'user' | 'machine';
  enabled: boolean;
}

class FakeLoginItemApp implements LoginItemApp {
  readonly writes: Array<{
    openAtLogin: boolean;
    path: string;
    args: string[];
    name: string;
    enabled?: boolean;
  }> = [];
  readonly isPackaged: boolean;
  readonly executablePath: string;
  readonly items: FakeLoginItem[];
  rejectEveEnable = false;
  rejectLegacyRemoval = false;

  constructor(options: {
    isPackaged?: boolean;
    executablePath?: string;
    items?: FakeLoginItem[];
  } = {}) {
    this.isPackaged = options.isPackaged ?? true;
    this.executablePath = options.executablePath ?? EVE_EXE;
    this.items = options.items ?? [];
  }

  getPath(name: 'exe'): string {
    expect(name).toBe('exe');
    return this.executablePath;
  }

  getLoginItemSettings(options: { path?: string; args?: string[] } = {}) {
    const executablePath = options.path ?? this.executablePath;
    const args = options.args ?? [];
    const matchingItems = this.items.filter(
      (item) =>
        path.win32.normalize(item.path).toLowerCase() ===
          path.win32.normalize(executablePath).toLowerCase() &&
        item.args.join('\0') === args.join('\0')
    );
    return {
      openAtLogin: matchingItems.some((item) => item.scope === 'user'),
      executableWillLaunchAtLogin: matchingItems.some(
        (item) => item.scope === 'user' && item.enabled
      ),
      launchItems: matchingItems.map((item) => ({
        ...item,
        args: [...item.args],
      })),
    };
  }

  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    path: string;
    args: string[];
    name: string;
    enabled?: boolean;
  }): void {
    this.writes.push({
      ...settings,
      args: [...settings.args],
    });
    const existingIndex = this.items.findIndex(
      (item) =>
        item.scope === 'user' &&
        item.name === settings.name &&
        path.win32.normalize(item.path).toLowerCase() ===
          path.win32.normalize(settings.path).toLowerCase() &&
        item.args.join('\0') === settings.args.join('\0')
    );

    if (!settings.openAtLogin) {
      if (
        this.rejectLegacyRemoval &&
        LEGACY_LOGIN_ITEM_NAMES.includes(
          settings.name as (typeof LEGACY_LOGIN_ITEM_NAMES)[number]
        )
      ) {
        return;
      }
      if (existingIndex >= 0) {
        this.items.splice(existingIndex, 1);
      }
      return;
    }
    if (this.rejectEveEnable && settings.name === EVE_APP_ID) {
      return;
    }

    const item: FakeLoginItem = {
      name: settings.name,
      path: settings.path,
      args: [...settings.args],
      scope: 'user',
      enabled: settings.enabled ?? true,
    };
    if (existingIndex >= 0) {
      this.items[existingIndex] = item;
    } else {
      this.items.push(item);
    }
  }
}

function item(
  name: string,
  executablePath: string,
  options: Partial<Pick<FakeLoginItem, 'args' | 'scope' | 'enabled'>> = {}
): FakeLoginItem {
  return {
    name,
    path: executablePath,
    args: options.args ?? [],
    scope: options.scope ?? 'user',
    enabled: options.enabled ?? true,
  };
}

describe('Gate 4 launch-on-login policy', () => {
  test('creates only the approved Eve entry after explicit packaged-Windows opt-in', () => {
    const app = new FakeLoginItemApp();

    const result = applyLaunchOnBoot(app, true, {
      platform: 'win32',
      localAppData: LOCAL_APP_DATA,
    });

    expect(result).toEqual({
      removedLegacyEntries: 0,
      ignoredLegacyCandidates: 0,
    });
    expect(app.items).toEqual([
      item(EVE_APP_ID, EVE_EXE),
    ]);
    expect(app.writes).toEqual([
      {
        openAtLogin: true,
        enabled: true,
        name: EVE_APP_ID,
        path: EVE_EXE,
        args: [],
      },
    ]);
  });

  test('ordinary launch removes only exact allowlisted entries without creating Eve', () => {
    const unpackedPath = String.raw`C:\dev\murmur\Murmur.exe`;
    const app = new FakeLoginItemApp({
      items: [
        ...LEGACY_LOGIN_ITEM_NAMES.map((name) => item(name, LEGACY_EXE)),
        item('Murmur', unpackedPath),
        item('murmur', LEGACY_EXE),
        item('Murmur Candidate', LEGACY_EXE),
        item('Murmur', LEGACY_EXE, { args: ['--hidden'] }),
        item('Murmur', LEGACY_EXE, { scope: 'machine' }),
        item('Unrelated', String.raw`C:\Elsewhere\Other.exe`),
      ],
    });

    const result = reconcileLegacyLoginItems(app, {
      platform: 'win32',
      localAppData: LOCAL_APP_DATA,
    });

    expect(result).toEqual({
      removedLegacyEntries: 3,
      ignoredLegacyCandidates: 3,
    });
    expect(app.items).toEqual([
      item('Murmur', unpackedPath),
      item('murmur', LEGACY_EXE),
      item('Murmur Candidate', LEGACY_EXE),
      item('Murmur', LEGACY_EXE, { args: ['--hidden'] }),
      item('Murmur', LEGACY_EXE, { scope: 'machine' }),
      item('Unrelated', String.raw`C:\Elsewhere\Other.exe`),
    ]);
    expect(app.writes.map((write) => write.name)).toEqual([
      ...LEGACY_LOGIN_ITEM_NAMES,
    ]);
  });

  test('disabling removes only the exact Eve registration', () => {
    const app = new FakeLoginItemApp({
      items: [
        item(EVE_APP_ID, EVE_EXE),
        item(EVE_APP_ID, String.raw`C:\dev\Eve.exe`),
        item('Murmur', LEGACY_EXE),
      ],
    });

    const result = applyLaunchOnBoot(app, false, {
      platform: 'win32',
      localAppData: LOCAL_APP_DATA,
    });

    expect(result).toEqual({
      removedLegacyEntries: 0,
      ignoredLegacyCandidates: 0,
    });
    expect(app.items).toEqual([
      item(EVE_APP_ID, String.raw`C:\dev\Eve.exe`),
      item('Murmur', LEGACY_EXE),
    ]);
    expect(app.writes).toEqual([
      {
        openAtLogin: false,
        name: EVE_APP_ID,
        path: EVE_EXE,
        args: [],
      },
    ]);
  });

  test('rejects non-Windows and unpackaged callers without an OS write', () => {
    for (const testCase of [
      { app: new FakeLoginItemApp(), platform: 'linux' as const },
      {
        app: new FakeLoginItemApp({ isPackaged: false }),
        platform: 'win32' as const,
      },
    ]) {
      expect(() =>
        applyLaunchOnBoot(testCase.app, true, {
          platform: testCase.platform,
          localAppData: LOCAL_APP_DATA,
        })
      ).toThrow(LOGIN_ITEM_UNAVAILABLE);
      expect(testCase.app.writes).toEqual([]);
    }
  });

  test('does not leave an Eve entry when the exact legacy path is unavailable', () => {
    const app = new FakeLoginItemApp();

    expect(() =>
      applyLaunchOnBoot(app, true, {
        platform: 'win32',
      })
    ).toThrow(LOGIN_ITEM_UNAVAILABLE);
    expect(app.items).toEqual([]);
  });

  test('rejects invalid IPC values before an OS write', () => {
    for (const value of [undefined, null, 0, 1, '', 'false', {}, []]) {
      const app = new FakeLoginItemApp();
      expect(() =>
        applyLaunchOnBoot(app, value, {
          platform: 'win32',
          localAppData: LOCAL_APP_DATA,
        })
      ).toThrow(TypeError);
      expect(app.writes).toEqual([]);
    }
  });

  test('rolls back an Eve entry that cannot be verified before legacy cleanup', () => {
    const app = new FakeLoginItemApp({
      items: [
        item('Murmur', LEGACY_EXE),
      ],
    });
    app.rejectEveEnable = true;

    expect(() =>
      applyLaunchOnBoot(app, true, {
        platform: 'win32',
        localAppData: LOCAL_APP_DATA,
      })
    ).toThrow(LOGIN_ITEM_UPDATE_FAILED);

    expect(app.items).toEqual([
      item('Murmur', LEGACY_EXE),
    ]);
    expect(app.writes.map((write) => write.name)).toEqual([
      EVE_APP_ID,
      EVE_APP_ID,
    ]);
  });

  test('rolls back Eve when an exact legacy entry cannot be removed', () => {
    const app = new FakeLoginItemApp({
      items: [
        item('Murmur', LEGACY_EXE),
      ],
    });
    app.rejectLegacyRemoval = true;

    expect(() =>
      applyLaunchOnBoot(app, true, {
        platform: 'win32',
        localAppData: LOCAL_APP_DATA,
      })
    ).toThrow(LOGIN_ITEM_UPDATE_FAILED);

    expect(app.items).toEqual([
      item('Murmur', LEGACY_EXE),
    ]);
    expect(app.writes.map((write) => write.name)).toEqual([
      EVE_APP_ID,
      'Murmur',
      EVE_APP_ID,
    ]);
  });

  test('updates the operating-system registration before settings persistence', async () => {
    const source = await Bun.file(
      new URL('../src/main/ipc/handlers.ts', import.meta.url)
    ).text();
    const applyIndex = source.indexOf('applyLaunchOnBoot(app, value');
    const persistIndex = source.indexOf('updateSetting(key, value)');

    expect(applyIndex).toBeGreaterThan(-1);
    expect(persistIndex).toBeGreaterThan(applyIndex);
  });
});
