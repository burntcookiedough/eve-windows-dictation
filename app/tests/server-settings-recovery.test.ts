import { describe, expect, test } from 'bun:test';
import {
  recoverInterruptedManagedPreparation,
  serverSettingsStateKey,
  shouldClearServerSettings,
  shouldRetryServerSettings,
} from '../src/renderer/app/server-settings-recovery';

const starting = { status: 'starting' as const, managed: true };
const unmanagedStarting = { status: 'starting' as const, managed: false };
const ready = {
  status: 'running' as const,
  managed: true,
  port: 51490,
  wsUrl: 'ws://localhost:51490/transcribe',
  version: '0.8.0',
  engineStatus: { current: 'whisper', status: 'ready' as const },
};

describe('Settings server-state recovery', () => {
  test('retries after a loading-to-ready transition without polling or duplicate in-flight calls', () => {
    expect(shouldRetryServerSettings(starting, false, false, null)).toBeFalse();
    const readyKey = serverSettingsStateKey(ready);
    expect(shouldRetryServerSettings(ready, false, false, null)).toBeTrue();
    expect(shouldRetryServerSettings(ready, false, true, null)).toBeFalse();
    expect(shouldRetryServerSettings(ready, false, false, readyKey)).toBeFalse();
    expect(shouldRetryServerSettings(ready, true, false, readyKey)).toBeFalse();
  });

  test('retries when the live endpoint or engine readiness changes and clears stale choices while stopped', () => {
    const readyKey = serverSettingsStateKey(ready);
    const loading = { ...ready, engineStatus: { current: 'whisper', status: 'loading' as const } };
    expect(serverSettingsStateKey(loading)).not.toBe(readyKey);
    expect(shouldRetryServerSettings(loading, false, false, readyKey)).toBeTrue();
    expect(shouldClearServerSettings(null)).toBeFalse();
    expect(shouldClearServerSettings(starting)).toBeTrue();
    expect(shouldClearServerSettings(ready)).toBeFalse();
  });

  test('retries when the live endpoint changes even if its port is reused', () => {
    const samePortDifferentEndpoint = { ...ready, wsUrl: 'ws://127.0.0.1:51490/transcribe' };
    expect(serverSettingsStateKey(samePortDifferentEndpoint)).not.toBe(serverSettingsStateKey(ready));
  });

  test('clears an interrupted managed preparation after the server stops', () => {
    const lifecycle = {
      pending: { engine: 'nemotron', nemotron_model: 'nvidia/canary-qwen-2.5b' },
      requested: true,
      active: true,
      observed: true,
      applying: true,
    };

    expect(recoverInterruptedManagedPreparation(starting, lifecycle)).toEqual({
      pending: {},
      requested: false,
      active: false,
      observed: false,
      applying: false,
      message: 'The managed speech server stopped while model settings were being prepared. Restart it, then select and apply the model again.',
    });
    expect(recoverInterruptedManagedPreparation(ready, lifecycle)).toBeNull();
  });

  test('does not emit another recovery after an interrupted preparation is already clear', () => {
    expect(recoverInterruptedManagedPreparation(starting, {
      pending: {},
      requested: false,
      active: false,
      observed: false,
      applying: false,
    })).toBeNull();
  });

  test('preserves staged preparation during an unmanaged development outage', () => {
    const lifecycle = {
      pending: { engine: 'whisper' },
      requested: true,
      active: true,
      observed: true,
      applying: true,
    };

    expect(shouldClearServerSettings(unmanagedStarting)).toBeTrue();
    expect(recoverInterruptedManagedPreparation(unmanagedStarting, lifecycle)).toBeNull();
  });
});
