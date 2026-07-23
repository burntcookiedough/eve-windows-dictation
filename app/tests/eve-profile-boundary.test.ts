import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareUserDataRootSync } from '../src/main/user-data-root';

const temporaryRoots: string[] = [];

function createFixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'murmur-profile-boundary-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('user-data root preparation', () => {
  test('creates a regular direct child and removes its write probe', () => {
    const fixture = createFixtureRoot();
    const appData = path.join(fixture, 'Roaming');
    mkdirSync(appData);

    const userData = prepareUserDataRootSync(appData, 'murmur');

    expect(userData).toBe(path.join(appData, 'murmur'));
    expect(readdirSync(userData)).toEqual([]);
  });

  test('allows a legitimately redirected appData parent', () => {
    const fixture = createFixtureRoot();
    const actualAppData = path.join(fixture, 'actual-roaming');
    const redirectedAppData = path.join(fixture, 'redirected-roaming');
    mkdirSync(actualAppData);
    symlinkSync(
      actualAppData,
      redirectedAppData,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const userData = prepareUserDataRootSync(redirectedAppData, 'murmur');

    expect(userData).toBe(path.join(redirectedAppData, 'murmur'));
    expect(readdirSync(path.join(actualAppData, 'murmur'))).toEqual([]);
  });

  test('rejects a userData root that is a file', () => {
    const fixture = createFixtureRoot();
    const appData = path.join(fixture, 'Roaming');
    mkdirSync(appData);
    writeFileSync(path.join(appData, 'murmur'), 'not a directory');

    expect(() => prepareUserDataRootSync(appData, 'murmur')).toThrow();
  });

  test('rejects a userData root redirected to a controlled legacy fixture', () => {
    const fixture = createFixtureRoot();
    const appData = path.join(fixture, 'Roaming');
    const controlledLegacy = path.join(fixture, 'controlled-legacy');
    mkdirSync(appData);
    mkdirSync(controlledLegacy);
    symlinkSync(
      controlledLegacy,
      path.join(appData, 'murmur'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    expect(() => prepareUserDataRootSync(appData, 'murmur')).toThrow(
      /regular directory|redirects outside/
    );
    expect(readdirSync(controlledLegacy)).toEqual([]);
  });
});
