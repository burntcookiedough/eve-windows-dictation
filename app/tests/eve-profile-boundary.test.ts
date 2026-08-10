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
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import {
  prepareUserDataRootSync,
  type UserDataRootFileSystem,
} from '../src/main/user-data-root';
import { EVE_USER_DATA_DIRECTORY_NAME } from '../src/main/identity';

const temporaryRoots: string[] = [];
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function createFixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'murmur-profile-boundary-'));
  temporaryRoots.push(root);
  return root;
}

function snapshotMetadata(root: string): Array<{ relative: string; size: number; mtimeMs: number }> {
  const entries: Array<{ relative: string; size: number; mtimeMs: number }> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const fullPath = path.join(directory, name);
      const stats = statSync(fullPath);
      const relative = path.relative(root, fullPath);
      entries.push({ relative, size: stats.size, mtimeMs: stats.mtimeMs });
      if (stats.isDirectory()) {
        visit(fullPath);
      }
    }
  };

  visit(root);
  return entries.sort((left, right) => left.relative.localeCompare(right.relative));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('user-data root preparation', () => {
  test.skipIf(process.platform !== 'win32')('sets controlled Eve paths before a real Electron singleton lock', () => {
    const fixture = createFixtureRoot();
    const appData = path.join(fixture, 'Roaming');
    const localAppData = path.join(fixture, 'Local');
    const userProfile = path.join(fixture, 'Profile');
    const temp = path.join(fixture, 'Temp');
    const legacyRoot = path.join(appData, 'murmur');
    const legacySentinel = path.join(legacyRoot, 'legacy-sentinel.txt');
    const bundlePath = path.join(fixture, 'bootstrap-core.cjs');
    const runnerPath = path.join(fixture, 'electron-bootstrap-smoke.cjs');
    const resultPath = path.join(fixture, 'electron-bootstrap-result.json');
    const preBootstrapUserData = path.join(fixture, 'PreBootstrapUserData');
    const qaAppData = path.join(fixture, 'QaRoaming');
    const qaRequestedUserData = path.join(qaAppData, 'eve');
    const electronPath = path.join(
      appRoot,
      'node_modules',
      'electron',
      'dist',
      'electron.exe'
    );

    mkdirSync(legacyRoot, { recursive: true });
    mkdirSync(localAppData);
    mkdirSync(userProfile);
    mkdirSync(temp);
    mkdirSync(qaAppData);
    const qaCanonicalAppData = realpathSync.native(qaAppData);
    writeFileSync(legacySentinel, 'controlled legacy data');

    buildSync({
      entryPoints: [path.join(appRoot, 'src', 'main', 'bootstrap-core.ts')],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      logLevel: 'silent',
    });

    const qaBundlePath = path.join(fixture, 'qa-profile-isolation.cjs');
    buildSync({
      entryPoints: [path.join(appRoot, 'src', 'main', 'qa-profile-isolation.ts')],
      outfile: qaBundlePath,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      logLevel: 'silent',
    });

    writeFileSync(
      runnerPath,
      `
const fs = require('node:fs');
const { app } = require('electron');
const { bootstrapApplication } = require(${JSON.stringify(bundlePath)});
const { resolveQaProfileIsolation } = require(${JSON.stringify(qaBundlePath)});

const events = [];

(async () => {
  try {
    const qaProfileIsolation = resolveQaProfileIsolation(process.argv);
    app.setPath('appData', qaProfileIsolation ? qaProfileIsolation.appDataPath : ${JSON.stringify(appData)});
    app.setName('Murmur');
    const electronApp = {
      getPath(name) {
        const value = app.getPath(name);
        events.push(\`get:\${name}:\${value}\`);
        return value;
      },
      setPath(name, value) {
        app.setPath(name, value);
        events.push(\`set:\${name}:\${value}\`);
      },
      requestSingleInstanceLock() {
        events.push(
          \`lock:userData:\${app.getPath('userData')}:sessionData:\${app.getPath('sessionData')}\`
        );
        return app.requestSingleInstanceLock();
      },
      quit() {
        events.push('quit');
        app.quit();
      },
      setAppUserModelId(id) {
        events.push(\`app-id:\${id}\`);
        app.setAppUserModelId(id);
      },
    };
    const loaded = await bootstrapApplication(
      electronApp,
      async () => {
        events.push('load');
      },
      { platform: 'win32', userDataDirectoryName: 'Eve' }
    );
    fs.writeFileSync(
      ${JSON.stringify(resultPath)},
      JSON.stringify({
        loaded,
        events,
        userData: app.getPath('userData'),
        sessionData: app.getPath('sessionData'),
        lockHeld: app.hasSingleInstanceLock(),
        electronVersion: process.versions.electron,
      })
    );
    app.releaseSingleInstanceLock();
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(
      ${JSON.stringify(resultPath)},
      JSON.stringify({ events, error: String(error && error.stack ? error.stack : error) })
    );
    if (app.hasSingleInstanceLock()) app.releaseSingleInstanceLock();
    app.exit(1);
  }
})();
`,
      'utf8'
    );

    const result = Bun.spawnSync({
      cmd: [
        electronPath,
        `--user-data-dir=${preBootstrapUserData}`,
        runnerPath,
      ],
      cwd: fixture,
      env: {
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        USERPROFILE: userProfile,
        HOME: userProfile,
        TEMP: temp,
        TMP: temp,
        PATH: process.env.PATH,
        PATHEXT: process.env.PATHEXT,
        SystemRoot: process.env.SystemRoot,
        windir: process.env.windir,
        ComSpec: process.env.ComSpec,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.success).toBeTrue();
    expect(result.exitCode).toBe(0);

    const smoke = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      loaded: boolean;
      events: string[];
      userData: string;
      sessionData: string;
      lockHeld: boolean;
      electronVersion: string;
    };
    const eveRoot = path.join(appData, 'Eve');
    const { electronVersion, ...smokeState } = smoke;

    expect(electronVersion).toMatch(/^40\./);
    expect(smokeState).toEqual({
      loaded: true,
      events: [
        `get:appData:${appData}`,
        `set:userData:${eveRoot}`,
        `set:sessionData:${eveRoot}`,
        `lock:userData:${eveRoot}:sessionData:${eveRoot}`,
        'app-id:io.github.burntcookiedough.eve',
        'load',
      ],
      userData: eveRoot,
      sessionData: eveRoot,
      lockHeld: true,
    });
    expect(readFileSync(legacySentinel, 'utf8')).toBe('controlled legacy data');
    expect(readdirSync(legacyRoot)).toEqual(['legacy-sentinel.txt']);

    const normalProfileMetadataBeforeQa = snapshotMetadata(appData);
    const qaResult = Bun.spawnSync({
      cmd: [
        electronPath,
        '--eve-qa-isolation',
        `--eve-qa-user-data-root=${qaRequestedUserData}`,
        runnerPath,
      ],
      cwd: fixture,
      env: {
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        USERPROFILE: userProfile,
        HOME: userProfile,
        TEMP: temp,
        TMP: temp,
        PATH: process.env.PATH,
        PATHEXT: process.env.PATHEXT,
        SystemRoot: process.env.SystemRoot,
        windir: process.env.windir,
        ComSpec: process.env.ComSpec,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(qaResult.success).toBeTrue();
    expect(qaResult.exitCode).toBe(0);

    const qaSmoke = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      loaded: boolean;
      events: string[];
      userData: string;
      sessionData: string;
      lockHeld: boolean;
      electronVersion: string;
    };
    const qaEveRoot = path.join(qaCanonicalAppData, 'Eve');
    const { electronVersion: qaElectronVersion, ...qaSmokeState } = qaSmoke;
    expect(qaElectronVersion).toMatch(/^40\./);
    expect(qaSmokeState).toEqual({
      loaded: true,
      events: [
        `get:appData:${qaAppData}`,
        `set:userData:${qaEveRoot}`,
        `set:sessionData:${qaEveRoot}`,
        `lock:userData:${qaEveRoot}:sessionData:${qaEveRoot}`,
        'app-id:io.github.burntcookiedough.eve',
        'load',
      ],
      userData: qaEveRoot,
      sessionData: qaEveRoot,
      lockHeld: true,
    });
    expect(snapshotMetadata(appData)).toEqual(normalProfileMetadataBeforeQa);
    expect(readFileSync(legacySentinel, 'utf8')).toBe('controlled legacy data');
    expect(readdirSync(legacyRoot)).toEqual(['legacy-sentinel.txt']);

    const normalProfileMetadataBeforeInvalidQa = snapshotMetadata(appData);
    const invalidQaResult = Bun.spawnSync({
      cmd: [electronPath, '--eve-qa-isolation', runnerPath],
      cwd: fixture,
      env: {
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        USERPROFILE: userProfile,
        HOME: userProfile,
        TEMP: temp,
        TMP: temp,
        PATH: process.env.PATH,
        PATHEXT: process.env.PATHEXT,
        SystemRoot: process.env.SystemRoot,
        windir: process.env.windir,
        ComSpec: process.env.ComSpec,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(invalidQaResult.success).toBeFalse();
    expect(invalidQaResult.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      events: [],
      error: expect.stringMatching(/Invalid packaged QA profile arguments/),
    });
    expect(snapshotMetadata(appData)).toEqual(normalProfileMetadataBeforeInvalidQa);
    expect(readFileSync(legacySentinel, 'utf8')).toBe('controlled legacy data');
    expect(readdirSync(legacyRoot)).toEqual(['legacy-sentinel.txt']);
  });

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
