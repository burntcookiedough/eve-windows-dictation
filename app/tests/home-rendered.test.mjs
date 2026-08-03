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
  test('contains the expressive hero and avoids horizontal overflow across phases, widths, and zooms', () => {
    expect(result.measurements).toHaveLength(12);
    for (const measurement of result.measurements) {
      expect(measurement.hero).toBeTrue();
      expect(measurement.orb).toBeTrue();
      expect(measurement.owner.overflowY).toBe('auto');
      expect(measurement.owner.scrollWidth).toBeLessThanOrEqual(measurement.owner.clientWidth);
      expect(measurement.document.scrollWidth).toBeLessThanOrEqual(measurement.document.clientWidth);
      expect(measurement.actionCount).toBe(3);
    }
  });

  test('keeps truthful readiness copy for ready, download, and error states', () => {
    expect(result.measurements.find((item) => item.phase === 'ready').heading).toBe('Ready for dictation');
    expect(result.measurements.find((item) => item.phase === 'downloading').heading).toBe('Preparing speech model');
    expect(result.measurements.find((item) => item.phase === 'error').heading).toBe('Speech setup needs attention');
  });

  test('writes isolated deterministic screenshots', () => {
    expect(result.screenshots).toHaveLength(3);
    for (const screenshot of result.screenshots) expect(existsSync(screenshot)).toBeTrue();
    expect(existsSync(result.userDataPath)).toBeFalse();
  });
});
