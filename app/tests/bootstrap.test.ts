import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { bootstrapApplication, type BootstrapApp } from '../src/main/bootstrap-core';
import {
  EVE_PRODUCT_NAME,
  EVE_USER_DATA_DIRECTORY_NAME,
  MURMUR_IDENTITY,
  resolveUserDataPath,
} from '../src/main/identity';

const APP_DATA_PATH = path.join('test-root', 'AppData', 'Roaming');

class FakeApp implements BootstrapApp {
  readonly events: string[] = [];
  lockGranted = true;

  requestSingleInstanceLock(): boolean {
    this.events.push('lock');
    return this.lockGranted;
  }

  quit(): void {
    this.events.push('quit');
  }

  getPath(name: 'appData'): string {
    this.events.push(`get:${name}`);
    return APP_DATA_PATH;
  }

  setPath(name: 'userData' | 'sessionData', value: string): void {
    this.events.push(`set:${name}:${value}`);
  }

  setAppUserModelId(id: string): void {
    this.events.push(`app-id:${id}`);
  }
}

describe('application identity bootstrap', () => {
  test('keeps the published Murmur identity active', () => {
    expect(MURMUR_IDENTITY).toEqual({
      productName: 'Murmur',
      appId: 'com.murmur.app',
      userDataDirectoryName: 'murmur',
      nsisGuid: '0204d005-75b3-5b31-b1f6-ef2831e2b204',
    });
    expect(EVE_PRODUCT_NAME).toBe('Eve');
    expect(EVE_USER_DATA_DIRECTORY_NAME).toBe('Eve');
  });

  test('resolves the same explicit Murmur userData directory', () => {
    expect(resolveUserDataPath(APP_DATA_PATH, MURMUR_IDENTITY.userDataDirectoryName)).toBe(
      path.join(APP_DATA_PATH, 'murmur')
    );
  });

  test('locks and selects userData before application modules load', async () => {
    const fakeApp = new FakeApp();

    const loaded = await bootstrapApplication(
      fakeApp,
      async () => {
        fakeApp.events.push('load');
      },
      {
        platform: 'win32',
        userDataDirectoryName: EVE_USER_DATA_DIRECTORY_NAME,
        prepareUserDataRoot: (appDataPath, directoryName) => {
          fakeApp.events.push(`prepare:${directoryName}`);
          return resolveUserDataPath(appDataPath, directoryName);
        },
      }
    );

    expect(loaded).toBeTrue();
    expect(fakeApp.events).toEqual([
      'lock',
      'get:appData',
      'prepare:Eve',
      `set:userData:${path.join(APP_DATA_PATH, 'Eve')}`,
      `set:sessionData:${path.join(APP_DATA_PATH, 'Eve')}`,
      'app-id:com.murmur.app',
      'load',
    ]);
  });

  test('does not select paths or load modules when another instance owns the lock', async () => {
    const fakeApp = new FakeApp();
    fakeApp.lockGranted = false;

    const loaded = await bootstrapApplication(
      fakeApp,
      async () => {
        fakeApp.events.push('load');
      },
      {
        platform: 'win32',
        userDataDirectoryName: EVE_USER_DATA_DIRECTORY_NAME,
        prepareUserDataRoot: (appDataPath, directoryName) =>
          resolveUserDataPath(appDataPath, directoryName),
      }
    );

    expect(loaded).toBeFalse();
    expect(fakeApp.events).toEqual(['lock', 'quit']);
  });

  test('does not set Electron paths or load modules when root preparation fails', async () => {
    const fakeApp = new FakeApp();

    await expect(
      bootstrapApplication(
        fakeApp,
        async () => {
          fakeApp.events.push('load');
        },
        {
          platform: 'win32',
          userDataDirectoryName: EVE_USER_DATA_DIRECTORY_NAME,
          prepareUserDataRoot: () => {
            fakeApp.events.push('prepare:failed');
            throw new Error('write denied');
          },
        }
      )
    ).rejects.toThrow('write denied');

    expect(fakeApp.events).toEqual([
      'lock',
      'get:appData',
      'prepare:failed',
    ]);
  });
});
