import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
const screenshotDir = resolve(tmpdir(), `eve-history-export-screenshots-${process.pid}`);
const vitePort = 53600 + (process.pid % 100);
const fixtureUrl = `http://127.0.0.1:${vitePort}/app/fixtures/history-export-fixture.html`;
const vite = Bun.spawn(['node', resolve(appRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {
  cwd: appRoot,
  env: { ...process.env, MURMUR_DEV_PORT: String(vitePort) },
  stdout: 'ignore',
  stderr: 'pipe',
  windowsHide: true,
});

let viteStopped = false;
async function stopVite() {
  if (viteStopped) return;
  viteStopped = true;
  vite.kill();
  await vite.exited;
}

afterAll(stopVite);

let result;
try {
  let fixtureReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(fixtureUrl)).ok) {
        fixtureReady = true;
        break;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!fixtureReady) {
    await stopVite();
    const stderr = await new Response(vite.stderr).text();
    throw new Error(`History export fixture server did not start: ${stderr}`);
  }

  const child = Bun.spawn([
    resolve(appRoot, 'node_modules/electron/dist/electron.exe'),
    resolve(appRoot, 'tests/fixtures/history-export-electron.cjs'),
    fixtureUrl,
  ], {
    cwd: appRoot,
    env: { ...process.env, EVE_HISTORY_EXPORT_SCREENSHOT_DIR: screenshotDir },
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`History export fixture exited ${code}: ${stderr || stdout}`);
  result = JSON.parse(stdout);
  await fs.rm(result.userDataPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
} catch (error) {
  await stopVite();
  throw error;
}

describe('rendered History export controls', () => {
  test('contains controls without horizontal overflow at narrow widths and 200% zoom', () => {
    expect(result.measurements.length).toBe(5);
    for (const measurement of result.measurements) {
      expect(measurement.owner.scrollWidth).toBeLessThanOrEqual(measurement.owner.clientWidth);
      expect(measurement.document.scrollWidth).toBeLessThanOrEqual(measurement.document.clientWidth);
      expect(measurement.hasFormat).toBeTrue();
      for (const height of measurement.controlHeights) expect(height).toBeGreaterThanOrEqual(36);
    }
  });

  test('renders explicit all and selected export states', () => {
    const all = result.measurements.find((measurement) => measurement.state === 'all');
    const selected = result.measurements.find((measurement) => measurement.state === 'selected');
    expect(all.hasExportAll).toBeTrue();
    expect(all.hasExportSelected).toBeFalse();
    expect(selected.hasExportAll).toBeFalse();
    expect(selected.hasExportSelected).toBeTrue();
    expect(selected.selectedCount).toBe('1 selected');
  });

  test('captures deterministic screenshots for visual review', () => {
    expect(result.screenshots).toHaveLength(2);
    for (const screenshot of result.screenshots) expect(existsSync(screenshot)).toBeTrue();
  });
});
