import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'bun:test';

const hostedWindows = process.platform === 'win32'
  && process.env.GITHUB_ACTIONS === 'true'
  && process.env.RUNNER_ENVIRONMENT === 'github-hosted';

test.skipIf(!hostedWindows)('native clipboard round trip on disposable hosted Windows', async () => {
  const root = resolve(mkdtempSync(join(tmpdir(), 'eve-hosted-clipboard-')));
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('eve-hosted-clipboard-')) {
    throw new Error('Unexpected hosted clipboard test directory.');
  }
  const appDir = resolve(import.meta.dir, '..');
  const env = { ...process.env, EVE_HOSTED_CLIPBOARD_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([
      resolve(appDir, 'node_modules/electron/dist/electron.exe'),
      resolve(import.meta.dir, 'fixtures/clipboard-native-hosted.cjs'),
    ], { cwd: appDir, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    watchdog = setTimeout(() => child?.kill(), 20_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain('HOSTED_CLIPBOARD_PROOF=passed');
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
