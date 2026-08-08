import type { ServerPidFile } from '../../shared/types.js';

/**
 * Bundled Windows servers may spend over 30 seconds importing CTranslate2/Torch
 * and discovering capabilities before they can write their PID file on a cold start.
 * Keep this bounded PID wait separate from the health-readiness allowance below.
 */
export const START_PID_TIMEOUT_MS = 180_000;
export const START_HEALTH_TIMEOUT_MS = 180_000;

export interface PidWaitClock {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function waitForPidFile(
  readPidFile: () => ServerPidFile | null,
  timeoutMs: number,
  expectedStartedAfterMs?: number,
  clock: PidWaitClock = {},
): Promise<ServerPidFile | null> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const startedAt = now();

  while (true) {
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) break;

    const pidData = readPidFile();
    if (
      pidData &&
      (expectedStartedAfterMs === undefined || pidData.startedAt >= expectedStartedAfterMs)
    ) {
      return pidData;
    }
    await sleep(Math.min(200, remaining));
  }

  return null;
}
