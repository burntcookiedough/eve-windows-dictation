import { describe, expect, test } from 'bun:test';
import {
  serverSettingsStateKey,
  shouldClearServerSettings,
  shouldRetryServerSettings,
} from '../src/renderer/app/server-settings-recovery';

const starting = { status: 'starting' as const, managed: true };
const ready = {
  status: 'running' as const,
  managed: true,
  port: 51490,
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
});
