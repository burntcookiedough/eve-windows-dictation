import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
const fixtureTempRoot = resolve(tmpdir());
const screenshotDir = resolve(fixtureTempRoot, 'eve-phase3-settings-server-screenshots');
const vitePort = 52100 + (process.pid % 100);
const viteProcess = Bun.spawn([
  'node',
  resolve(appRoot, 'node_modules/vite/bin/vite.js'),
  '--host',
  '127.0.0.1',
], {
  cwd: appRoot,
  env: { ...process.env, MURMUR_DEV_PORT: String(vitePort) },
  stdout: 'ignore',
  stderr: 'pipe',
  windowsHide: true,
});
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

async function waitForFixtureServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(fixtureUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  viteProcess.kill();
  const stderr = await new Response(viteProcess.stderr).text();
  throw new Error(`Vite fixture server did not start on port ${vitePort}: ${stderr}`);
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
  viteProcess.kill();
  await viteProcess.exited;
});

await waitForFixtureServer();
const result = await runElectron();
const { measurements } = result;

describe('rendered Phase 3 Server and diagnostics fixture', () => {
  test('keeps one page scroll owner and no horizontal overflow at narrow/high zoom states', () => {
    expect(measurements.length).toBe(30);
    for (const measurement of measurements) {
      expect(measurement.owner.overflowY).toBe('auto');
      expect(measurement.owner.scrollHeight).toBeGreaterThan(measurement.owner.clientHeight);
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
    expect(ready.external).toBeFalse();
    expect(ready.restriction).toBeFalse();
    expect(ready.healthButtonsDisabled.every((disabled) => disabled === false)).toBeTrue();
    expect(error.status).toBe('Error');
    expect(error.external).toBeFalse();
    expect(error.healthButtonsDisabled.every((disabled) => disabled === false)).toBeTrue();
  });

  test('renders external restrictions without hiding factual health, diagnostics, or logs', () => {
    const external = measurements.find((measurement) => measurement.state === 'external-ready' && measurement.zoom === 1 && measurement.viewport.width === 960);
    expect(external.external).toBeTrue();
    expect(external.restriction).toBeTrue();
    expect(external.healthButtonsDisabled.every((disabled) => disabled === true)).toBeTrue();
    expect(external.autoStartDisabled).toBeTrue();
    expect(external.status).toBe('Running');
    expect(external.privacyWarning).toBeTrue();
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
    expect(result.screenshots).toHaveLength(5);
    for (const screenshot of result.screenshots) {
      expect(existsSync(screenshot)).toBeTrue();
    }
    expect(result.userDataExists).toBeFalse();
  });
});
