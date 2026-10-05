import { expect, test } from 'bun:test';
import path from 'node:path';

test('debug and malformed-frame logs omit synthetic content without changing output', async () => {
  const fixturePath = path.join(import.meta.dir, 'fixtures', 'debug-content-privacy.bun.ts');
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    MURMUR_DEBUG: '1',
  };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value) childEnv[name] = value;
  }
  const child = Bun.spawn([process.execPath, 'run', fixturePath], {
    cwd: path.resolve(import.meta.dir, '..'),
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const watchdog = setTimeout(() => child.kill(), 30_000);
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    clearTimeout(watchdog);
  }

  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  const proof = JSON.parse(stdout.trim()) as Record<string, unknown>;
  expect(proof).toMatchObject({
    processedOutput: 'Private marker EVE_ALPHA7_SYNTHETIC_PRIVATE_MARKER_92bf.',
    clipboardWrite: 'Private marker EVE_ALPHA7_SYNTHETIC_PRIVATE_MARKER_92bf.',
    inputLength: 55,
    outputLength: 56,
    clipboardLength: 56,
    malformedDataLength: 49,
    contentAbsentFromTransport: true,
    contentAbsentFromConsole: true,
  });
});
