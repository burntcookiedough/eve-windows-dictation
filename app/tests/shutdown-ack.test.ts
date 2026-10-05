import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';

const appDir = resolve(import.meta.dir, '..');
const electronExecutable = resolve(
  appDir,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

describe('native shutdown acknowledgement', () => {
  test('waits for renderer acknowledgement and allows retry after rejection', async () => {
    if (process.platform !== 'win32') return;

    const tempRoot = mkdtempSync(join(tmpdir(), 'eve-shutdown-ack-test-'));
    const resolvedTempRoot = resolve(tempRoot);
    const resolvedOsTemp = resolve(tmpdir());
    if (dirname(resolvedTempRoot) !== resolvedOsTemp || !basename(resolvedTempRoot).startsWith('eve-shutdown-ack-test-')) {
      throw new Error(`Refusing unexpected shutdown test path: ${resolvedTempRoot}`);
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.EVE_SHUTDOWN_ACK_TEMP_ROOT = resolvedTempRoot;

    let child: ReturnType<typeof Bun.spawn> | undefined;
    let childFinished = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn({
        cmd: [electronExecutable, resolve(import.meta.dir, 'fixtures', 'shutdown-ack-electron.cjs')],
        cwd: appDir,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      });
      const completed = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).then(([stdout, stderr, exitCode]) => ({ kind: 'completed' as const, stdout, stderr, exitCode }));
      const timedOut = new Promise<{ kind: 'timeout' }>((resolveTimeout) => {
        watchdog = setTimeout(() => resolveTimeout({ kind: 'timeout' }), 15000);
      });
      const outcome = await Promise.race([completed, timedOut]);
      clearTimeout(watchdog);

      if (outcome.kind === 'timeout') {
        child.kill();
        const stopped = await completed;
        childFinished = true;
        throw new Error(`Electron shutdown probe exceeded its 15000ms timeout: ${stopped.stderr || stopped.stdout}`);
      }
      childFinished = true;
      const { stdout, stderr, exitCode } = outcome;

      if (exitCode !== 0) {
        throw new Error([
          `Electron shutdown probe failed (status ${exitCode}, signal ${child.signalCode ?? 'none'}).`,
          stdout,
          stderr,
        ].filter(Boolean).join('\n'));
      }

      const proofLine = stdout.split(/\r?\n/).find((line) => line.startsWith('SHUTDOWN_ACK_PROOF='));
      expect(proofLine).toBeDefined();
      const proof = JSON.parse(proofLine!.slice('SHUTDOWN_ACK_PROOF='.length));
      expect(proof).toMatchObject({
        attemptCount: 2,
        failureShowCalled: true,
        failureFocusCalled: true,
        willQuitBeforeAck: false,
        acknowledged: true,
        willQuitAfterAck: true,
        willQuitCount: 1,
      });
      expect(proof.retryAckDelayMs).toBeGreaterThan(5000);
      console.log(proofLine);
    } finally {
      clearTimeout(watchdog);
      if (child && !childFinished) {
        child.kill();
        await child.exited;
      }
      rmSync(resolvedTempRoot, { recursive: true, force: true });
    }
  }, 25000);
});
