import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

test('History pagination survives repeated empty filters in rendered Electron', async () => {
  if (process.platform !== 'win32') return;
  const appRoot = resolve(import.meta.dir, '..');
  const portProbe = createServer();
  await new Promise<void>((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(0, '127.0.0.1', resolve); });
  const address = portProbe.address();
  await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Expected allocated port');
  const env = { ...process.env, MURMUR_DEV_PORT: String(address.port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const vite = Bun.spawn(['node', join(appRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {
    cwd: appRoot, env, stdout: 'ignore', stderr: 'pipe', windowsHide: true,
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const url = `http://127.0.0.1:${address.port}/app/fixtures/history-pagination-fixture.html`;
  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('Pagination Vite server did not become ready');
    child = Bun.spawn([join(appRoot, 'node_modules/electron/dist/electron.exe'), join(import.meta.dir, 'fixtures/history-pagination-electron.cjs'), url], {
      cwd: appRoot, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    const completed = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    timer = setTimeout(() => child?.kill(), 20000);
    const [stdout, stderr, code] = await completed;
    if (code !== 0) throw new Error(`Pagination fixture failed (${code}): ${stderr}\n${stdout}`);
    expect(stdout).toContain('PAGINATION_PROOF=3');
  } finally {
    clearTimeout(timer);
    if (child) {
      if (child.exitCode === null) child.kill();
      await child.exited;
      // This exact disposable profile belongs to the child just launched above.
      rmSync(resolve(tmpdir(), `eve-pagination-${child.pid}`), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
    vite.kill();
    await vite.exited;
  }
}, 40000);
