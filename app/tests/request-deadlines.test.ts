import { describe, expect, mock, test } from 'bun:test';
import type { HealthState } from '../src/main/services/server-health';

mock.module('electron', () => ({
  app: {
    getPath: () => process.cwd(),
    getVersion: () => 'test-build',
  },
  BrowserWindow: class {},
}));

const { ServerManager } = await import('../src/main/services/server-manager');
const { app: electronApp } = await import('electron');
const { getServerSettings } = await import('../src/main/services/server-settings');

type PrivateServerManager = {
  getHealthState: (port: number, timeoutMs?: number) => Promise<HealthState>;
  getState: InstanceType<typeof ServerManager>['getState'];
  setMainWindow: InstanceType<typeof ServerManager>['setMainWindow'];
  startHealthPolling: (port: number) => void;
  stopHealthPolling: () => void;
  updateStatus: (status: 'running') => void;
  waitForHealth: (port: number, timeoutMs: number) => Promise<HealthState | null>;
};

function asPrivateManager(manager: InstanceType<typeof ServerManager>): PrivateServerManager {
  return manager as unknown as PrivateServerManager;
}

function restoreGlobalProperty(
  name: 'fetch' | 'setInterval' | 'setTimeout',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}

describe('Electron request deadlines', () => {
  test('coalesces starts while packaged GPU runtime validation is pending', async () => {
    const packagedApp = electronApp as unknown as { isPackaged: boolean };
    const previousPackaged = packagedApp.isPackaged;
    let finishValidation: ((value: null) => void) | undefined;
    let validations = 0;
    const validation = new Promise<null>((resolve) => { finishValidation = resolve; });
    const manager = new ServerManager({
      getValidatedRuntime: () => { validations++; return validation; },
    } as unknown as ConstructorParameters<typeof ServerManager>[0]);
    const privateManager = manager as unknown as {
      readPidFile: () => null;
      getServerCommand: () => null;
    };
    let commandChecks = 0;
    privateManager.readPidFile = () => null;
    privateManager.getServerCommand = () => { commandChecks++; return null; };
    packagedApp.isPackaged = true;

    try {
      const first = manager.start();
      const second = manager.start();
      expect(second).toBe(first);
      expect(validations).toBe(1);
      finishValidation?.(null);
      await Promise.all([first, second]);
      expect(commandChecks).toBe(1);

      await manager.start();
      expect(validations).toBe(2);
    } finally {
      packagedApp.isPackaged = previousPackaged;
    }
  });

  test('restart waits for a pending startup before launching a replacement', async () => {
    const manager = new ServerManager();
    const privateManager = manager as unknown as {
      managed: boolean;
      startOnce: () => Promise<void>;
      updateStatus: (status: 'starting' | 'running') => void;
    };
    let finishFirstStart: (() => void) | undefined;
    const firstStartup = new Promise<void>((resolve) => { finishFirstStart = resolve; });
    let starts = 0;
    privateManager.managed = true;
    privateManager.startOnce = async () => {
      starts++;
      privateManager.updateStatus('starting');
      if (starts === 1) await firstStartup;
      privateManager.updateStatus('running');
    };

    const first = manager.start();
    const restarted = manager.restart();
    expect(starts).toBe(1);

    finishFirstStart?.();
    await Promise.all([first, restarted]);
    expect(starts).toBe(2);
    expect(manager.getState().status).toBe('running');
  });

  test('restarts and starts wait for one shutdown before starting a replacement', async () => {
    const manager = new ServerManager();
    const privateManager = manager as unknown as {
      managed: boolean;
      pidFile: { pid: number; port: number; startedAt: number } | null;
      startOnce: () => Promise<void>;
      updateStatus: (status: 'running') => void;
      waitForProcessExit: () => Promise<boolean>;
    };
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    let finishExit: ((exited: boolean) => void) | undefined;
    let stopEntered: (() => void) | undefined;
    const processExit = new Promise<boolean>((resolve) => { finishExit = resolve; });
    const shutdownStarted = new Promise<void>((resolve) => { stopEntered = resolve; });
    let starts = 0;

    privateManager.managed = true;
    privateManager.pidFile = { pid: 1234, port: 51717, startedAt: Date.now() };
    privateManager.waitForProcessExit = () => {
      stopEntered?.();
      return processExit;
    };
    privateManager.startOnce = async () => {
      starts++;
      privateManager.updateStatus('running');
    };
    privateManager.updateStatus('running');
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async () => ({ ok: true }),
    });

    try {
      const first = manager.restart();
      const second = manager.restart();
      const directStart = manager.start();
      await shutdownStarted;
      expect(starts).toBe(0);
      finishExit?.(true);
      await Promise.all([first, second, directStart]);
      expect(starts).toBe(1);
      expect(manager.getState().status).toBe('running');
    } finally {
      finishExit?.(true);
      restoreGlobalProperty('fetch', originalFetch);
    }
  });

  test('restores running state after a transient health-check failure', async () => {
    const manager = asPrivateManager(new ServerManager());
    const originalSetInterval = Object.getOwnPropertyDescriptor(globalThis, 'setInterval');
    const originalGetHealthState = manager.getHealthState;
    let poll: (() => Promise<void>) | undefined;
    const healthStates: HealthState[] = [
      { healthy: false },
      {
        healthy: true,
        engineStatus: { current: 'whisper', status: 'ready' },
        runtime: { app_build: null, server_build: '0.8.2-alpha.5', pack_id: null, effective_device: 'cpu' },
      },
    ];

    Object.defineProperty(globalThis, 'setInterval', {
      configurable: true,
      writable: true,
      value: ((handler: unknown) => {
        poll = handler as () => Promise<void>;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
    });
    manager.getHealthState = async () => healthStates.shift() ?? { healthy: true };

    try {
      manager.updateStatus('running');
      manager.startHealthPolling(51717);

      await poll?.();
      expect(manager.getState().status).toBe('error');

      await poll?.();
      expect(manager.getState()).toMatchObject({
        status: 'running',
        engineStatus: { current: 'whisper', status: 'ready' },
        runtime: { effective_device: 'cpu', pack_id: null },
      });
    } finally {
      manager.stopHealthPolling();
      manager.getHealthState = originalGetHealthState;
      restoreGlobalProperty('setInterval', originalSetInterval);
    }
  });

  test('ignores a late healthy response after health polling stops', async () => {
    const manager = asPrivateManager(new ServerManager());
    const originalSetInterval = Object.getOwnPropertyDescriptor(globalThis, 'setInterval');
    const originalGetHealthState = manager.getHealthState;
    let poll: (() => Promise<void>) | undefined;
    let resolveHealth: ((health: HealthState) => void) | undefined;
    const deferredHealth = new Promise<HealthState>((resolve) => {
      resolveHealth = resolve;
    });
    let healthRequestCount = 0;
    const publishedStates: unknown[] = [];

    Object.defineProperty(globalThis, 'setInterval', {
      configurable: true,
      writable: true,
      value: ((handler: unknown) => {
        poll = handler as () => Promise<void>;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
    });
    manager.getHealthState = async () => {
      healthRequestCount += 1;
      return healthRequestCount === 1 ? { healthy: false } : deferredHealth;
    };
    manager.setMainWindow({
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, state: unknown) => publishedStates.push(state),
      },
    } as unknown as Parameters<InstanceType<typeof ServerManager>['setMainWindow']>[0]);

    try {
      manager.updateStatus('running');
      manager.startHealthPolling(51717);

      await poll?.();
      expect(manager.getState().status).toBe('error');
      publishedStates.length = 0;

      const latePoll = poll?.();
      manager.stopHealthPolling();
      resolveHealth?.({
        healthy: true,
        version: 'late-version',
        diagnostics: {
          generated_at: 'late-response',
          cuda: { available: true, device: 'cuda' },
          cuda_dlls: { available: true },
          nvidia_driver: { available: true },
          vc_redist: { required: false },
          warnings: [],
        },
        engineStatus: { current: 'whisper', status: 'ready' },
      });
      await latePoll;

      expect({ state: manager.getState(), publishedStates }).toMatchObject({
        state: {
          status: 'error',
          version: undefined,
          diagnostics: undefined,
          engineStatus: undefined,
        },
        publishedStates: [],
      });
    } finally {
      manager.stopHealthPolling();
      manager.getHealthState = originalGetHealthState;
      restoreGlobalProperty('setInterval', originalSetInterval);
    }
  });

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
