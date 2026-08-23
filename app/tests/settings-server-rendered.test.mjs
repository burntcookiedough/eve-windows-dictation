import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
const fixtureTempRoot = resolve(tmpdir());
const screenshotDir = resolve(fixtureTempRoot, 'eve-phase3-settings-server-screenshots');
const viteStartPort = 5173;
const maxViteStartAttempts = 32;

function isAddressInUseError(message) {
  return /EADDRINUSE|address already in use|address-in-use|port \d+ is already in use/i.test(message);
}

function spawnVite(port) {
  return Bun.spawn([
    'node',
    resolve(appRoot, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
  ], {
    cwd: appRoot,
    env: { ...process.env, MURMUR_DEV_PORT: String(port) },
    stdout: 'ignore',
    stderr: 'pipe',
    windowsHide: true,
  });
}

async function stopOwnedVite(viteProcess) {
  if (viteProcess.exitCode === null) viteProcess.kill();
  await viteProcess.exited;
}

async function readViteStderr(viteProcess) {
  await viteProcess.exited;
  return new Response(viteProcess.stderr).text();
}

async function startViteFixture() {
  let lastAddressError = '';

  for (let attempt = 0; attempt < maxViteStartAttempts; attempt += 1) {
    const port = viteStartPort + attempt;
    const viteProcess = spawnVite(port);

    try {
      await waitForFixtureServer(port, viteProcess);
      return { port, viteProcess };
    } catch (error) {
      const processExited = viteProcess.exitCode !== null;
      const stderr = processExited ? await readViteStderr(viteProcess) : '';
      await stopOwnedVite(viteProcess);

      if (!processExited || !isAddressInUseError(stderr)) {
        const detail = stderr || (error instanceof Error ? error.message : String(error));
        throw new Error(`Vite fixture server failed on port ${port}: ${detail}`);
      }

      lastAddressError = stderr;
    }
  }

  throw new Error(`Vite fixture server exhausted ${maxViteStartAttempts} startup attempts: ${lastAddressError}`);
}

const { port: vitePort, viteProcess } = await startViteFixture();
const fixtureUrl = `http://127.0.0.1:${vitePort}/app/fixtures/settings-server-fixture.html`;
const electronPath = resolve(appRoot, 'node_modules/electron/dist/electron.exe');
const runnerPath = resolve(appRoot, 'tests/fixtures/settings-server-electron.cjs');

function assertSafeUserDataPath(target) {
  const resolvedTarget = resolve(target);
  const relativeTarget = relative(fixtureTempRoot, resolvedTarget);
  if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget) || !basename(resolvedTarget).startsWith('eve-settings-server-')) {
    throw new Error(`Refusing to remove unexpected fixture path: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

async function cleanupUserData(target) {
  const resolvedTarget = assertSafeUserDataPath(target);
  await fs.rm(resolvedTarget, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  return existsSync(resolvedTarget);
}

async function waitForFixtureServer(port, process) {
  const url = `http://127.0.0.1:${port}/app/fixtures/settings-server-fixture.html`;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Vite fixture server exited with code ${process.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Vite fixture server did not start on port ${port}`);
}

function runElectron() {
  const child = Bun.spawn([electronPath, runnerPath, fixtureUrl], {
    cwd: appRoot,
    env: { ...process.env, EVE_PHASE3_SCREENSHOT_DIR: screenshotDir },
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  return Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(async ([stdout, stderr, code]) => {
    let result = null;
    let parseError = null;
    try {
      result = JSON.parse(stdout);
    } catch (error) {
      parseError = error;
    }
    const userDataPath = result?.userDataPath ?? resolve(fixtureTempRoot, `eve-settings-server-${child.pid}`);
    const userDataExists = await cleanupUserData(userDataPath);
    if (code !== 0) throw new Error(`Electron Server fixture exited with ${code}: ${stderr || stdout}`);
    if (!result) throw new Error(`Electron Server fixture returned invalid JSON: ${parseError}\n${stderr}\n${stdout}`);
    return { ...result, userDataExists };
  });
}

afterAll(async () => {
  await stopOwnedVite(viteProcess);
});

const result = await runElectron();
const { measurements } = result;

describe('rendered Phase 3 Server and diagnostics fixture', () => {
  test('keeps one page scroll owner and no horizontal overflow at narrow/high zoom states', () => {
    expect(measurements.length).toBe(48);
    for (const measurement of measurements) {
      expect(measurement.owner.overflowY).toBe('auto');
      expect(measurement.owner.scrollHeight).toBeGreaterThanOrEqual(measurement.owner.clientHeight);
      expect(measurement.owner.scrollWidth).toBeLessThanOrEqual(measurement.owner.clientWidth);
      expect(measurement.document.scrollWidth).toBeLessThanOrEqual(measurement.document.clientWidth);
      expect(measurement.scrollersOutsideLogs).toBe(1);
      expect(measurement.controlsContained, JSON.stringify({ state: measurement.state, zoom: measurement.zoom, viewport: measurement.viewport, controlBounds: measurement.controlBounds, owner: measurement.owner.rect })).toBeTrue();
    }
  });

  test('renders managed ready and error health states with enabled managed actions', () => {
    const ready = measurements.find((measurement) => measurement.state === 'managed-ready' && measurement.zoom === 1 && measurement.viewport.width === 960);
    const error = measurements.find((measurement) => measurement.state === 'managed-error' && measurement.zoom === 1 && measurement.viewport.width === 960);
    expect(ready.status).toBe('Running');
    expect(ready.healthButtonsDisabled.every((disabled) => disabled === false)).toBeTrue();
    expect(error.status).toBe('Error');
    expect(error.healthButtonsDisabled.every((disabled) => disabled === false)).toBeTrue();
  });

  test('keeps collapsed and expanded logs associated, private-data warning visible, and output bounded', () => {
    const collapsed = measurements.find((measurement) => measurement.state === 'managed-ready' && !measurement.logsExpanded && measurement.zoom === 1 && measurement.viewport.width === 960);
    const expanded = measurements.find((measurement) => measurement.state === 'managed-ready' && measurement.logsExpanded && measurement.zoom === 1 && measurement.viewport.width === 960);
    expect(collapsed.logsAssociation).toBeTrue();
    expect(collapsed.logsExpanded).toBeFalse();
    expect(collapsed.privacyWarning).toBeTrue();
    expect(expanded.logsAssociation).toBeTrue();
    expect(expanded.logsExpanded).toBeTrue();
    expect(expanded.logsScroller.overflowY).toBe('auto');
    expect(expanded.logsScroller.overscrollBehaviorY).toBe('contain');
    expect(expanded.logsScroller.scrollHeight).toBeGreaterThan(expanded.logsScroller.clientHeight);
    expect(expanded.logsScroller.tabIndex).toBe(0);
    expect(expanded.logsScroller.role).toBe('log');
    expect(expanded.logsScroller.ariaLabel).toBe('Server log output');
  });

  test('distinguishes loading, empty, unavailable, short, and bounded long log states', () => {
    const short = measurements.find((measurement) => measurement.state === 'managed-short' && measurement.zoom === 1 && measurement.viewport.width === 960);
    const empty = measurements.find((measurement) => measurement.state === 'managed-empty' && measurement.zoom === 1 && measurement.viewport.width === 960);
    const unavailable = measurements.find((measurement) => measurement.state === 'managed-log-error' && measurement.zoom === 1 && measurement.viewport.width === 960);
    const loading = measurements.find((measurement) => measurement.state === 'managed-log-loading' && measurement.zoom === 1 && measurement.viewport.width === 960);
    const long = measurements.find((measurement) => measurement.state === 'managed-long' && measurement.zoom === 1 && measurement.viewport.width === 960);

    expect(short.logState).toBe('ready');
    expect(short.logBodySize).toBe('short');
    expect(short.logsScroller.overflowY).toBe('hidden');
    expect(short.logCopyDisabled).toBeFalse();

    expect(empty.logState).toBe('empty');
    expect(empty.logEmpty).toBeTrue();
    expect(empty.logCopyDisabled).toBeTrue();
    expect(empty.logsScroller).toBeNull();

    expect(unavailable.logState).toBe('error');
    expect(unavailable.logError).toBeTrue();
    expect(unavailable.logStateRole).toBe('alert');
    expect(unavailable.logRetryVisible).toBeTrue();
    expect(unavailable.logCopyDisabled).toBeTrue();
    expect(unavailable.logsScroller).toBeNull();

    expect(loading.logState).toBe('loading');
    expect(loading.logStateRole).toBe('status');
    expect(loading.logStateLive).toBe('polite');
    expect(loading.logCopyDisabled).toBeTrue();
    expect(loading.logsScroller).toBeNull();

    expect(long.logBodySize).toBe('long');
    expect(long.logsScroller.overflowY).toBe('auto');
    expect(long.logsScroller.overscrollBehaviorY).toBe('contain');
  });

  test('keeps heading associations, visible focus, and long strings contained', () => {
    const longStates = measurements.filter((measurement) => measurement.state === 'managed-long');
    for (const measurement of longStates) {
      expect(measurement.headingAssociation).toBeTrue();
      expect(measurement.headingIdsUnique).toBeTrue();
      expect(measurement.headingLevels[0]).toBe(1);
      expect(measurement.headingLevels.slice(1).every((level) => level === 2 || level === 3)).toBeTrue();
      expect(measurement.serverSubsectionCount).toBe(4);
      expect(measurement.focus.focused).toBeTrue();
      expect(measurement.focus.outlineWidth !== '0px' || measurement.focus.boxShadow !== 'none' || measurement.focus.containerBoxShadow !== 'none').toBeTrue();
    }
  });

  test('cleans the isolated Electron userData directory and writes deterministic screenshots', () => {
    expect(result.screenshots).toHaveLength(4);
    for (const screenshot of result.screenshots) {
      expect(existsSync(screenshot)).toBeTrue();
    }
    expect(result.userDataExists).toBeFalse();
  });
});
