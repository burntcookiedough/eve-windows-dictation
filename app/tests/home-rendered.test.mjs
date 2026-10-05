import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
const screenshotDir = resolve(tmpdir(), 'eve-home-screenshots');
const vitePort = 53000 + (process.pid % 100);
const fixtureUrl = `http://127.0.0.1:${vitePort}/app/fixtures/home-fixture.html`;
const vite = Bun.spawn(['node', resolve(appRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {
  cwd: appRoot,
  env: { ...process.env, MURMUR_DEV_PORT: String(vitePort) },
  stdout: 'ignore', stderr: 'pipe', windowsHide: true,
});

for (let attempt = 0; attempt < 60; attempt += 1) {
  try { if ((await fetch(fixtureUrl)).ok) break; } catch {}
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
}

const child = Bun.spawn([
  resolve(appRoot, 'node_modules/electron/dist/electron.exe'),
  resolve(appRoot, 'tests/fixtures/home-electron.cjs'),
  fixtureUrl,
], {
  cwd: appRoot,
  env: { ...process.env, EVE_HOME_SCREENSHOT_DIR: screenshotDir },
  stdout: 'pipe', stderr: 'pipe', windowsHide: true,
});
const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
if (code !== 0) throw new Error(`Home fixture exited ${code}: ${stderr || stdout}`);
const result = JSON.parse(stdout);
await fs.rm(result.userDataPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

afterAll(async () => { vite.kill(); await vite.exited; });

describe('rendered Home experience', () => {
  test('refreshes unfinished indexing then stops polling and displays the complete-history streak', () => {
    expect(result.indexingRefresh.initial).toBe('—');
    expect(result.indexingRefresh.completed).toEqual({ words: '123', streak: '400', calls: 2 });
    expect(result.indexingRefresh.settledCalls).toBe(2);
  });
  test('keeps the two-column Home, transcript, and shortcuts visible without page overflow', () => {
    expect(result.measurements).toHaveLength(9);
    for (const measurement of result.measurements) {
      expect(measurement.presence).toBeTrue();
      expect(measurement.cactus).toBeTrue();
      expect(measurement.stats).toBeTrue();
      expect(measurement.transcript).toBeTrue();
      expect(measurement.shortcuts).toBeTrue();
      expect(measurement.owner.overflowY).toBe('hidden');
      expect(measurement.owner.scrollWidth).toBeLessThanOrEqual(measurement.owner.clientWidth);
      expect(measurement.owner.scrollHeight).toBeLessThanOrEqual(measurement.owner.clientHeight);
      expect(measurement.document.scrollWidth).toBeLessThanOrEqual(measurement.document.clientWidth);
    }
  });

  test('shows truthful service phases and keeps retry available for managed errors', () => {
    expect(result.measurements.find((item) => item.phase === 'ready').status).toBe('ready');
    expect(result.measurements.find((item) => item.phase === 'downloading').status).toContain('downloading · 48%');
    expect(result.measurements.find((item) => item.phase === 'error').status).toContain('speech setup needs attention');
    expect(result.measurements.find((item) => item.phase === 'error').retryButton).toBeTrue();
  });

  test('writes isolated deterministic screenshots', () => {
    expect(result.screenshots).toHaveLength(3);
    for (const screenshot of result.screenshots) expect(existsSync(screenshot)).toBeTrue();
    expect(existsSync(result.userDataPath)).toBeFalse();
  });
});
