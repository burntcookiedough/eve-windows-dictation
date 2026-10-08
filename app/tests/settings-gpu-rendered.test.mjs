import { afterAll, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { createServer } from 'node:net';

const appRoot = resolve(import.meta.dir, '..');
const portProbe = createServer();
await new Promise((resolvePort, rejectPort) => {
  portProbe.once('error', rejectPort);
  portProbe.listen(0, '127.0.0.1', resolvePort);
});
const port = portProbe.address().port;
await new Promise((resolveClose, rejectClose) => portProbe.close((error) => error ? rejectClose(error) : resolveClose()));
const vite = Bun.spawn(['node', resolve(appRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {
  cwd: appRoot, env: { ...process.env, MURMUR_DEV_PORT: String(port) }, stdout: 'ignore', stderr: 'pipe', windowsHide: true,
});
afterAll(async () => { vite.kill(); await vite.exited; });

test('production Settings GPU controls work offline, confirm removal, preserve preferences and keep progress local', async () => {
  const url = `http://127.0.0.1:${port}/app/fixtures/settings-gpu-fixture.html`;
  let available = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(url)).ok) { available = true; break; } } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!available) {
    vite.kill();
    await vite.exited;
    throw new Error(`GPU fixture server did not start: ${await new Response(vite.stderr).text()}`);
  }
  expect(available).toBeTrue();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = Bun.spawn([resolve(appRoot, 'node_modules/electron/dist/electron.exe'), resolve(appRoot, 'tests/fixtures/settings-gpu-electron.cjs'), url], {
    cwd: appRoot, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const target = resolve(tmpdir(), `eve-settings-gpu-${child.pid}`);
  const within = relative(resolve(tmpdir()), target);
  if (!within || within.startsWith('..') || isAbsolute(within) || !basename(target).startsWith('eve-settings-gpu-')) throw new Error('Unsafe fixture cleanup');
  await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  if (code !== 0) throw new Error(`GPU rendered fixture failed: ${stderr || stdout}`);
  const result = JSON.parse(stdout);
  expect(result.ready.repair).toBeTrue();
  expect(result.confirmation.calls).toEqual([]);
  expect(result.confirmation.focus).toBe('cancel');
  expect(result.confirmation.dialog).toContain('settings and downloaded models are not changed');
  expect(result.cancelled.calls).toEqual([]);
  expect(result.cancelled.focus).toBeTrue();
  expect(result.repairing.calls).toEqual(['repair']);
  expect(result.repairing.enabled).toBeFalse();
  expect(result.repairing.status).toContain('Verifying');
  expect(result.fallback).toContain('CPU fallback');
  expect(result.deviceUnknown).toContain('not reported');
  expect(result.deviceUnknown).not.toContain('CPU fallback');
  expect(result.removed.calls).toEqual(['repair', 'remove']);
  expect(result.removed.download).toBeTrue();
  expect(result.interrupted).toBeTrue();
  expect(result.broken).toEqual({ repair: true, remove: true });
  expect(result.repairedBroken).toEqual(['repair', 'remove', 'repair']);
  expect(result.rejectedRepair.alert).toContain('could not be repaired');
  expect(result.rejectedRepair.repairDisabled).toBeFalse();
  expect(result.rejectedRepair.calls).toEqual(['repair', 'remove', 'repair', 'repair']);
  expect(result.rejectedRemove.alert).toContain('could not be removed');
  expect(result.rejectedRemove.removeDisabled).toBeFalse();
  expect(result.rejectedRemove.sheetOpen).toBeFalse();
  expect(result.rejectedRemove.calls).toEqual(['repair', 'remove', 'repair', 'repair', 'remove']);
  for (const rejected of [result.rejectedRepair, result.rejectedRemove]) {
    expect(rejected.hasAction).toBeFalse();
    expect(rejected.hasRepair).toBeTrue();
    expect(rejected.hasRemove).toBeTrue();
    expect(rejected.calls).not.toContain('install');
    expect(rejected.calls).not.toContain('updateSetting');
  }
  for (const layout of result.layouts) {
    expect(layout.overflow).toBeFalse();
    expect(layout.local).toBeTrue();
    expect(layout.value).toBe(62);
  }
}, 30000);
