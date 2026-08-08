import { describe, expect, test } from 'bun:test';
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

  test('remains bounded at the cold-start PID allowance while health stays separate', async () => {
    const clock = fakeClock();
    const result = await waitForPidFile(() => null, START_PID_TIMEOUT_MS, undefined, clock);

    expect(result).toBeNull();
    expect(clock.elapsed()).toBe(START_PID_TIMEOUT_MS);
    expect(START_HEALTH_TIMEOUT_MS).toBe(180_000);
  });
});
