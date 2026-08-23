import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
const settingsViewSource = readFileSync(new URL('../src/renderer/app/views/SettingsView.svelte', import.meta.url), 'utf8');
const settingsMarkup = settingsViewSource.replace(/<script[\s\S]*?<\/script>/, '');
const fixtureTempRoot = resolve(tmpdir());
const screenshotDir = resolve(fixtureTempRoot, 'eve-phase2-settings-screenshots');
const vitePort = 52000 + (process.pid % 100);
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
const fixtureUrl = `http://127.0.0.1:${vitePort}/app/fixtures/settings-speech-fixture.html`;
const electronPath = resolve(appRoot, 'node_modules/electron/dist/electron.exe');
const runnerPath = resolve(appRoot, 'tests/fixtures/settings-speech-electron.cjs');

function assertSafeUserDataPath(target) {
  const resolvedTarget = resolve(target);
  const relativeTarget = relative(fixtureTempRoot, resolvedTarget);
  if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget) || !basename(resolvedTarget).startsWith('eve-settings-speech-')) {
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
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
    env: { ...process.env, EVE_PHASE2_SCREENSHOT_DIR: screenshotDir },
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  return Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, code]) => {
    let result = null;
    let parseError = null;
    try {
      result = JSON.parse(stdout);
    } catch (error) {
      parseError = error;
    }
    const userDataPath = result?.userDataPath ?? resolve(fixtureTempRoot, `eve-settings-speech-${child.pid}`);
    return cleanupUserData(userDataPath).then((userDataExists) => {
      if (code !== 0) throw new Error(`Electron Speech fixture exited with ${code}: ${stderr || stdout}`);
      if (!result) throw new Error(`Electron Speech fixture returned invalid JSON: ${parseError}\n${stderr}\n${stdout}`);
      return { ...result, userDataExists };
    });
  });
}

afterAll(async () => {
  viteProcess.kill();
  await viteProcess.exited;
});

await waitForFixtureServer();
const result = await runElectron();
const { measurements } = result;

describe('rendered Phase 2 Settings/Speech fixture', () => {
  test('keeps the alpha Settings markup free of deferred engine names and controls', () => {
    expect(settingsMarkup).not.toContain('Nemotron');
    expect(settingsMarkup).not.toContain('nemotron_model');
    expect(settingsMarkup).not.toContain('nemotron_device');
  });

  test('keeps the General and Speech fixture inside one page scroll owner at all zooms', () => {
    expect(measurements.length).toBe(30);
    for (const measurement of measurements) {
      expect(measurement.owner.overflowY).toBe('auto');
      expect(measurement.owner.overflowX).toBe('hidden');
      expect(measurement.owner.scrollHeight).toBeGreaterThanOrEqual(measurement.owner.clientHeight);
      expect(measurement.owner.scrollWidth - measurement.owner.clientWidth).toBeLessThanOrEqual(12);
      expect(measurement.document.scrollWidth).toBeLessThanOrEqual(measurement.document.clientWidth);
    }
  });

  test('renders radio/current/selected states and visible keyboard focus across ready/loading/error', () => {
    for (const state of ['ready', 'preparing', 'error']) {
      const stateMeasurements = measurements.filter((measurement) => measurement.view === 'speech' && measurement.state === state && !measurement.compatibility);
      expect(stateMeasurements.length).toBe(6);
      for (const measurement of stateMeasurements) {
        expect(measurement.optionCount).toBe(3);
        expect(measurement.checkedCount).toBe(1);
        expect(measurement.optionContained).toBeTrue();
        expect(measurement.focus.focusWithin).toBeTrue();
      }
    }

    const ready = measurements.find((measurement) => measurement.view === 'speech' && measurement.state === 'ready' && measurement.zoom === 1 && measurement.viewport.width === 960);
    const preparing = measurements.find((measurement) => measurement.view === 'speech' && measurement.state === 'preparing' && measurement.zoom === 1 && measurement.viewport.width === 960);
    const error = measurements.find((measurement) => measurement.view === 'speech' && measurement.state === 'error' && measurement.zoom === 1 && measurement.viewport.width === 960);
    expect(ready.states).toContain('Current');
    expect(ready.states).toContain('Available');
    expect(preparing.states.some((label) => label.includes('Selected') && label.includes('Preparing'))).toBeTrue();
    expect(error.states.some((label) => label.includes('Selected') && label.includes('Error'))).toBeTrue();
  });

  test('keeps the compatibility disclosure association', () => {
    const expanded = measurements.find((measurement) => measurement.compatibility);
    expect(expanded.compatibilityExpanded).toBeTrue();
    expect(expanded.compatibilityAssociation).toBeTrue();
  });

  test('keeps the renderer mounted while selecting every curated model', () => {
    expect(result.interactions).toHaveLength(3);
    expect(result.interactions.map((interaction) => interaction.label)).toEqual([
      'Recommended Multilingual, Current',
      'Maximum Multilingual Accuracy, Selected',
      'Lightweight, Selected',
    ]);
    for (const interaction of result.interactions) {
      expect(interaction.checked).toBeTrue();
      expect(interaction.panelPresent).toBeTrue();
      expect(interaction.optionCount).toBe(3);
      expect(interaction.rendererFailed).toBeFalse();
      expect(interaction.scrollDelta).toBeLessThanOrEqual(1);
    }
  });

  test('writes deterministic isolated screenshots and cleans Electron userData', () => {
    expect(result.screenshots).toHaveLength(4);
    for (const screenshot of result.screenshots) {
      expect(existsSync(screenshot)).toBeTrue();
    }
    expect(result.userDataExists).toBeFalse();
  });
});
