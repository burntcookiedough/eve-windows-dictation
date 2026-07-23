import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  prepareUserDataRootSync,
  type UserDataRootFileSystem,
} from '../src/main/user-data-root';
import { EVE_USER_DATA_DIRECTORY_NAME } from '../src/main/identity';

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

    const userData = prepareUserDataRootSync(appData, EVE_USER_DATA_DIRECTORY_NAME);

    expect(userData).toBe(path.join(appData, 'Eve'));
    expect(readdirSync(userData)).toEqual([]);
  });

  test('records no access to a controlled Murmur sibling', () => {
    const fixture = createFixtureRoot();
    const appData = path.join(fixture, 'Roaming');
    const legacyRoot = path.join(appData, 'murmur');
    const sentinelPath = path.join(legacyRoot, 'legacy-sentinel.txt');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(sentinelPath, 'controlled legacy data');
    const accesses: string[] = [];

    const tracedFileSystem: UserDataRootFileSystem = {
      realpath: (value) => {
        accesses.push(value);
        return realpathSync.native(value);
      },
      mkdir: (value) => {
        accesses.push(value);
        mkdirSync(value, { recursive: true });
      },
      lstat: (value) => {
        accesses.push(value);
        return lstatSync(value);
      },
      open: (value) => {
        accesses.push(value);
        return openSync(value, 'wx');
      },
      close: (descriptor) => closeSync(descriptor),
      unlink: (value) => {
        accesses.push(value);
        unlinkSync(value);
      },
    };

    const userData = prepareUserDataRootSync(
      appData,
      EVE_USER_DATA_DIRECTORY_NAME,
      tracedFileSystem
    );

    expect(userData).toBe(path.join(appData, 'Eve'));
    expect(
      accesses.filter(
        (value) => value === legacyRoot || value.startsWith(`${legacyRoot}${path.sep}`)
      )
    ).toEqual([]);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('controlled legacy data');
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

    const userData = prepareUserDataRootSync(redirectedAppData, EVE_USER_DATA_DIRECTORY_NAME);

    expect(userData).toBe(path.join(redirectedAppData, 'Eve'));
    expect(readdirSync(path.join(actualAppData, 'Eve'))).toEqual([]);
  });

  test('rejects a userData root that is a file', () => {
    const fixture = createFixtureRoot();
    const appData = path.join(fixture, 'Roaming');
    mkdirSync(appData);
    writeFileSync(path.join(appData, 'Eve'), 'not a directory');

    expect(() => prepareUserDataRootSync(appData, EVE_USER_DATA_DIRECTORY_NAME)).toThrow();
  });

  test('rejects a userData root redirected to a controlled legacy fixture', () => {
    const fixture = createFixtureRoot();
    const appData = path.join(fixture, 'Roaming');
    const controlledLegacy = path.join(fixture, 'controlled-legacy');
    mkdirSync(appData);
    mkdirSync(controlledLegacy);
    symlinkSync(
      controlledLegacy,
      path.join(appData, 'Eve'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    expect(() => prepareUserDataRootSync(appData, EVE_USER_DATA_DIRECTORY_NAME)).toThrow(
      /regular directory|redirects outside/
    );
    expect(readdirSync(controlledLegacy)).toEqual([]);
  });
});
