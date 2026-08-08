import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  START_HEALTH_TIMEOUT_MS,
  START_PID_TIMEOUT_MS,
  waitForPidFile,
} from '../src/main/services/server-startup.js';

const PID_FILE = {
  pid: 19736,
  port: 63328,
  startedAt: 30_001,
};

function fakeClock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (milliseconds: number) => {
      elapsed += milliseconds;
    },
    elapsed: () => elapsed,
  };
}

describe('packaged server startup timing', () => {
  test('accepts a PID file that appears after the former 30-second boundary', async () => {
    const clock = fakeClock();
    const result = await waitForPidFile(
      () => (clock.elapsed() > 30_000 ? PID_FILE : null),
      START_PID_TIMEOUT_MS,
      0,
      clock,
    );

    expect(result).toEqual(PID_FILE);
    expect(clock.elapsed()).toBeGreaterThan(30_000);
    expect(clock.elapsed()).toBeLessThanOrEqual(START_PID_TIMEOUT_MS);
  });

  test('caps a non-aligned timeout without extending the bounded wait', async () => {
    const clock = fakeClock();
    const result = await waitForPidFile(() => null, 30_001, undefined, clock);

    expect(result).toBeNull();
    expect(clock.elapsed()).toBe(30_001);
    expect(START_HEALTH_TIMEOUT_MS).toBe(180_000);
  });

  test('checks PID ownership before health readiness in ServerManager startup', () => {
    const source = readFileSync(
      new URL('../src/main/services/server-manager.ts', import.meta.url),
      'utf8',
    );
    const pidWait = source.indexOf('const pidData = await waitForPidFile');
    const ownership = source.indexOf(
      'await this.isOwnedServerProcess(pidData.pid, pidData.startedAt)',
      pidWait,
    );
    const health = source.indexOf('const health = await this.waitForHealth', ownership);

    expect(pidWait).toBeGreaterThanOrEqual(0);
    expect(ownership).toBeGreaterThan(pidWait);
    expect(health).toBeGreaterThan(ownership);
    expect(source.slice(ownership, health)).toContain(
      "throw new Error('Server process ownership could not be verified')",
    );
  });
});
