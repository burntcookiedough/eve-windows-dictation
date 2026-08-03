import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
const fixtureTempRoot = resolve(tmpdir());
const vitePort = 51900 + (process.pid % 100);
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
const fixtureUrl = `http://127.0.0.1:${vitePort}/app/fixtures/settings-layout-fixture.html`;
const electronPath = resolve(appRoot, 'node_modules/electron/dist/electron.exe');
const runnerPath = resolve(appRoot, 'tests/fixtures/settings-layout-electron.cjs');

function assertSafeUserDataPath(target) {
  const resolvedTarget = resolve(target);
  const relativeTarget = relative(fixtureTempRoot, resolvedTarget);
  if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget) || !basename(resolvedTarget).startsWith('eve-settings-layout-')) {
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
      // The child can fail before it emits its path; use its process ID for safe cleanup.
      parseError = error;
    }
    const userDataPath = result?.userDataPath ?? resolve(fixtureTempRoot, `eve-settings-layout-${child.pid}`);
    return cleanupUserData(userDataPath).then((userDataExists) => {
      if (code !== 0) throw new Error(`Electron layout fixture exited with ${code}: ${stderr || stdout}`);
      if (!result) throw new Error(`Electron layout fixture returned invalid JSON: ${errorMessage(parseError, stderr, stdout)}`);
      return { ...result, userDataExists };
    });
  });
}

function errorMessage(error, stderr, stdout) {
  return `${error instanceof Error ? error : new Error(String(error))}\n${stderr}\n${stdout}`;
}

afterAll(async () => {
  viteProcess.kill();
  await viteProcess.exited;
});

await waitForFixtureServer();
const result = await runElectron();
const { measurements } = result;

describe('rendered Settings layout fixture', () => {
  test('keeps the status strip in flow and preserves one page scroll owner', () => {
    for (const measurement of measurements) {
      expect(measurement.status.position).toBe('static');
      expect(measurement.status.rect.bottom).toBeLessThanOrEqual(measurement.main.top);
      expect(measurement.owner.overflowY).toBe('auto');
      expect(measurement.owner.scrollHeight).toBeGreaterThan(measurement.owner.clientHeight);
      expect(measurement.owner.scrollWidth).toBeLessThanOrEqual(measurement.owner.clientWidth);
      expect(measurement.document.scrollWidth).toBeLessThanOrEqual(measurement.document.clientWidth);
    }
  });

  test('contains controls and retains visible focus at narrow widths and high zoom', () => {
    const narrow = measurements.filter((measurement) => measurement.viewport.width <= 320);
    expect(narrow.length).toBe(3);
    for (const measurement of narrow) {
      expect(measurement.row.control.left).toBeGreaterThanOrEqual(measurement.row.rect.left);
      expect(measurement.row.control.right).toBeLessThanOrEqual(measurement.row.rect.right);
      expect(measurement.focus.outlineWidth !== '0px' || measurement.focus.boxShadow !== 'none').toBeTrue();
    }
  });

  test('keeps section heading associations in the rendered DOM', () => {
    for (const measurement of measurements) {
      expect(measurement.headingAssociation).toBeTrue();
      expect(measurement.headingIdsUnique).toBeTrue();
      expect(measurement.explicitHeadingId).toBeTrue();
    }
  });

  test('cleans the isolated Electron userData directory after the fixture run', () => {
    expect(result.userDataExists).toBeFalse();
  });
});
