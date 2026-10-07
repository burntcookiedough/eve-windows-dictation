import { afterAll, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
// Let Windows select an available port outside its reserved ranges. Vite's
// strictPort setting still fails loudly if another process wins the handoff.
const portProbe = createServer();
await new Promise((resolveListen, rejectListen) => {
  portProbe.once('error', rejectListen);
  portProbe.listen(0, '127.0.0.1', resolveListen);
});
const address = portProbe.address();
await new Promise((resolveClose, rejectClose) => {
  portProbe.close((error) => error ? rejectClose(error) : resolveClose());
});
if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port');
const vitePort = address.port;
const fixtureTimeoutMs = 45_000;
const fixtureUrl = `http://127.0.0.1:${vitePort}/app/fixtures/insights-chart-fixture.html`;
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
    throw new Error(`Insights chart fixture server did not start: ${stderr}`);
  }

  const child = Bun.spawn([
    resolve(appRoot, 'node_modules/electron/dist/electron.exe'),
    resolve(appRoot, 'tests/fixtures/insights-chart-electron.cjs'),
    fixtureUrl,
  ], {
    cwd: appRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  let watchdog;
  const completed = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, code]) => ({ kind: 'completed', stdout, stderr, code }));
  const timedOut = new Promise((resolveTimeout) => {
    watchdog = setTimeout(() => resolveTimeout({ kind: 'timeout' }), fixtureTimeoutMs);
  });
  const outcome = await Promise.race([completed, timedOut]);
  clearTimeout(watchdog);
  if (outcome.kind === 'timeout') {
    child.kill();
    await Promise.race([child.exited, new Promise((resolveWait) => setTimeout(resolveWait, 5000))]);
    await fs.rm(resolve(tmpdir(), `eve-insights-chart-${child.pid}`), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    throw new Error(`Insights chart fixture exceeded its ${fixtureTimeoutMs}ms watchdog and was terminated`);
  }
  const { stdout, stderr, code } = outcome;
  if (code !== 0) {
    await fs.rm(resolve(tmpdir(), `eve-insights-chart-${child.pid}`), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    throw new Error(`Insights chart fixture exited ${code}: ${stderr || stdout}`);
  }
  result = JSON.parse(stdout);
  await fs.rm(result.userDataPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
} catch (error) {
  await stopVite();
  throw error;
}

describe('rendered Insights chart sizing', () => {
  test('sizes the chart from its mounted host after async data and follows viewport resize', () => {
    expect(result.at400.viewportWidth).toBe(400);
    expect(result.at400.hostWidth).toBeGreaterThan(0);
    expect(result.at400.viewBoxWidth).toBe(Math.floor(result.at400.hostWidth));
    expect(result.at400.headPaddingTop).toBe('16px');
    expect(result.at400.heroFontSize).toBe('68px');
    expect(result.at400.metricFontSize).toBe('22px');
    expect(result.at400.metricPaddingLeft).toBe('18px');
    expect(result.afterResize.viewportWidth).toBe(560);
    expect(result.afterResize.hostWidth).toBeGreaterThan(result.at400.hostWidth);
    expect(result.afterResize.viewBoxWidth).toBe(Math.floor(result.afterResize.hostWidth));
  });

  test('refreshes during indexing without a history event and stops after completion', () => {
    expect(result.initialIndexing.requestCount).toBe(1);
    expect(result.initialIndexing.indexingMessageVisible).toBeTrue();
    expect(result.afterIndexingComplete.requestCount).toBe(2);
    expect(result.afterIndexingComplete.indexingMessageVisible).toBeFalse();
    expect(result.afterCompleteWait.requestCount).toBe(2);
    expect(result.afterCompleteWait.indexingMessageVisible).toBeFalse();
  });
});
