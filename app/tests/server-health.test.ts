import { describe, expect, test } from 'bun:test';
import {
  isMurmurServerCommandLine,
  parseHealthyResponse,
} from '../src/main/services/server-health';

describe('server health parsing', () => {
  test('preserves liveness while exposing engine loading state', () => {
    const health = parseHealthyResponse({
      status: 'healthy',
      version: '0.6.0',
      engine: {
        current: 'whisper',
        status: 'loading',
        pending: { engine: 'whisper', status: 'loading' },
      },
      model_download: { model: 'tiny', size_gb: 0.07, status: 'downloading' },
    });

    expect(health.healthy).toBe(true);
    expect(health.engineStatus?.status).toBe('loading');
    expect(health.modelDownload?.status).toBe('downloading');
  });

  test('does not treat malformed engine metadata as readiness', () => {
    const health = parseHealthyResponse({
      status: 'healthy',
      engine: { current: 'whisper', status: 'almost-ready' },
    });

    expect(health.healthy).toBe(true);
    expect(health.engineStatus).toBeUndefined();
  });

  test('rejects a non-object response', () => {
    expect(parseHealthyResponse(null)).toEqual({ healthy: false });
  });
});

describe('server process ownership', () => {
  test('recognizes the packaged Murmur Python entry point', () => {
    expect(
      isMurmurServerCommandLine(
        '"C:\\Program Files\\Murmur\\resources\\server\\.runtime\\python.exe" "C:\\Program Files\\Murmur\\resources\\server\\src\\main.py"'
      )
    ).toBe(true);
  });

  test('rejects unrelated Python processes', () => {
    expect(isMurmurServerCommandLine('python.exe C:\\work\\unrelated.py')).toBe(false);
    expect(isMurmurServerCommandLine('notepad.exe')).toBe(false);
  });
});
