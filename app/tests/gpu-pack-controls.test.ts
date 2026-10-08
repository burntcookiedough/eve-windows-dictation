import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

describe('B6 GPU Pack Controls isolated child runner', () => {
  test('runs controls fixture in isolated Bun child process without global electron pollution', async () => {
    const fixturePath = resolve(import.meta.dir, 'fixtures/gpu-pack-controls-fixture.ts');
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    const proc = Bun.spawn([process.execPath, 'test', fixturePath], {
      cwd: resolve(import.meta.dir, '..'),
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error(stdout);
      console.error(stderr);
    }

    expect(exitCode).toBe(0);
  }, 60000);
});
