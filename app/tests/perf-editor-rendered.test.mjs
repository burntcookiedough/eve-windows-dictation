import { test, expect } from 'bun:test';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

test('real Electron editor rejects script events and observes native insertText input', async () => {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const root = resolve(import.meta.dir, '..');
  const vite = Bun.spawn(['node', resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {
    cwd: root, env: { ...process.env, MURMUR_DEV_PORT: String(port) }, stdout: 'ignore', stderr: 'pipe', windowsHide: true,
  });
  let child;
  try {
    const url = `http://127.0.0.1:${port}/app/fixtures/isolated-editor-observer.html`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
      await Bun.sleep(100);
    }
    if (!ready) throw new Error('Isolated editor fixture did not start');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    child = Bun.spawn([resolve(root, 'node_modules/electron/dist/electron.exe'), resolve(root, 'tests/fixtures/perf-editor-electron.cjs'), url], { cwd: root, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    let timer;
    const outcome = await Promise.race([
      Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Editor fixture watchdog')), 30000); }),
    ]).finally(() => clearTimeout(timer));
    const [stdout, stderr, code] = outcome;
    if (code !== 0) throw new Error(stderr);
    const evidence = JSON.parse(stdout);
    expect(evidence.initial).toBeNull();
    expect(evidence.actual.eventType).toBe('input');
    expect(evidence.actual.charCount).toBe('Fictional validation sentence.'.length);
    expect(evidence.actual.clockDomain).toBe('isolated_editor_performance_now');
    // Native DOM insertion proof only, not an OS paste or dictation latency result.
  } finally {
    if (child && child.exitCode === null) child.kill();
    vite.kill(); await vite.exited;
  }
}, 45000);
