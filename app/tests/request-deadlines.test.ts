import { describe, expect, mock, test } from 'bun:test';
import type { HealthState } from '../src/main/services/server-health';

mock.module('electron', () => ({
  app: {
    getPath: () => process.cwd(),
  },
  BrowserWindow: class {},
}));

const { ServerManager } = await import('../src/main/services/server-manager');
const { getServerSettings } = await import('../src/main/services/server-settings');

type PrivateServerManager = {
  getHealthState: (port: number, timeoutMs?: number) => Promise<HealthState>;
  waitForHealth: (port: number, timeoutMs: number) => Promise<HealthState | null>;
};

function asPrivateManager(manager: InstanceType<typeof ServerManager>): PrivateServerManager {
  return manager as unknown as PrivateServerManager;
}

function restoreGlobalProperty(
  name: 'fetch' | 'setTimeout',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}

describe('Electron request deadlines', () => {
  test('keeps client deadlines beyond the server probe ceiling', async () => {
    const manager = asPrivateManager(new ServerManager());
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const scheduledDelays: number[] = [];

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      } as Response),
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      writable: true,
      value: ((_handler: unknown, delay?: number) => {
        scheduledDelays.push(delay ?? 0);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });

    try {
      expect(await manager.getHealthState(51717)).toEqual({ healthy: true });
      await getServerSettings('ws://localhost:51717/transcribe');

      expect(scheduledDelays).toHaveLength(2);
      const [healthDeadline, settingsDeadline] = scheduledDelays;
      const serverProbeCeilingMs = 2000;
      expect(healthDeadline).toBeGreaterThan(serverProbeCeilingMs);
      expect(healthDeadline).toBeLessThan(3000);
      expect(settingsDeadline).toBeGreaterThan(serverProbeCeilingMs);
    } finally {
      restoreGlobalProperty('fetch', originalFetch);
      restoreGlobalProperty('setTimeout', originalSetTimeout);
    }
  });

  test('aborts a health request when response body consumption stalls', async () => {
    const manager = asPrivateManager(new ServerManager());
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    let signal: AbortSignal | undefined;

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return Promise.resolve({
          ok: true,
          json: () => new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        } as Response);
      },
    });

    try {
      const outcome = await Promise.race([
        manager.getHealthState(51717, 20).then((health) => ({ kind: 'settled' as const, health })),
        new Promise<{ kind: 'test-timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'test-timeout' }), 250);
        }),
      ]);

      expect(outcome.kind).toBe('settled');
      if (outcome.kind === 'settled') {
        expect(outcome.health).toEqual({ healthy: false });
      }
      expect(signal?.aborted).toBeTrue();
    } finally {
      restoreGlobalProperty('fetch', originalFetch);
    }
  });

  test('keeps the health readiness wait inside its outer deadline', async () => {
    const manager = asPrivateManager(new ServerManager());
    const originalGetHealthState = manager.getHealthState;
    manager.getHealthState = () => new Promise<HealthState>(() => {});

    try {
      const outcome = await Promise.race([
        manager.waitForHealth(51717, 20).then((health) => ({ kind: 'settled' as const, health })),
        new Promise<{ kind: 'test-timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'test-timeout' }), 250);
        }),
      ]);

      expect(outcome.kind).toBe('settled');
      if (outcome.kind === 'settled') {
        expect(outcome.health).toBeNull();
      }
    } finally {
      manager.getHealthState = originalGetHealthState;
    }
  });

  test('passes an abort signal and rejects when a settings request times out', async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    let signal: AbortSignal | undefined;
    let fireTimeout: (() => void) | undefined;

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        });
      },
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      writable: true,
      value: ((handler: unknown, _delay?: number, ...args: unknown[]) => {
        if (typeof handler === 'function') {
          fireTimeout = () => (handler as (...callbackArgs: unknown[]) => void)(...args);
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });

    try {
      const request = getServerSettings('ws://localhost:51717/transcribe');
      await Promise.resolve();
      fireTimeout?.();

      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(signal?.aborted).toBeTrue();
    } finally {
      restoreGlobalProperty('fetch', originalFetch);
      restoreGlobalProperty('setTimeout', originalSetTimeout);
    }
  });
});
