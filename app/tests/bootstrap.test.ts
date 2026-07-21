import { describe, expect, test } from 'bun:test';
import { bootstrapApplication, type BootstrapApp } from '../src/main/bootstrap-core';
import { EVE_PRODUCT_NAME, MURMUR_IDENTITY, resolveUserDataPath } from '../src/main/identity';

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
    return 'C:\\Users\\test\\AppData\\Roaming';
  }

  setPath(name: 'userData', value: string): void {
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
  });

  test('resolves the same explicit Murmur userData directory', () => {
    expect(resolveUserDataPath('C:\\Users\\test\\AppData\\Roaming')).toBe(
      'C:\\Users\\test\\AppData\\Roaming\\murmur'
    );
  });

  test('locks and selects userData before application modules load', async () => {
    const fakeApp = new FakeApp();

    const loaded = await bootstrapApplication(
      fakeApp,
      async () => {
        fakeApp.events.push('load');
      },
      'win32'
    );

    expect(loaded).toBeTrue();
    expect(fakeApp.events).toEqual([
      'lock',
      'get:appData',
      'set:userData:C:\\Users\\test\\AppData\\Roaming\\murmur',
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
      'win32'
    );

    expect(loaded).toBeFalse();
    expect(fakeApp.events).toEqual(['lock', 'quit']);
  });
});
