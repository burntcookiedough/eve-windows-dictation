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

  test('validates and clamps model download progress', () => {
    const health = parseHealthyResponse({
      status: 'healthy',
      model_download: {
        model: 'large-v3-turbo',
        size_gb: 1.5,
        status: 'downloading',
        phase: 'downloading',
        progress_percent: 104.5,
        downloaded_bytes: 750,
        total_bytes: 1000,
        bytes_per_second: 25,
        eta_seconds: 10,
      },
    });

    expect(health.modelDownload?.progress_percent).toBe(100);
    expect(health.modelDownload?.downloaded_bytes).toBe(750);
    expect(health.modelDownload?.eta_seconds).toBe(10);
  });

  test('drops malformed model download progress fields', () => {
    const health = parseHealthyResponse({
      status: 'healthy',
      model_download: {
        model: 'tiny',
        size_gb: 0.07,
        status: 'downloading',
        phase: 'teleporting',
        progress_percent: Number.NaN,
        downloaded_bytes: -1,
        eta_seconds: Number.POSITIVE_INFINITY,
      },
    });

    expect(health.modelDownload?.phase).toBeUndefined();
    expect(health.modelDownload?.progress_percent).toBeUndefined();
    expect(health.modelDownload?.downloaded_bytes).toBeUndefined();
    expect(health.modelDownload?.eta_seconds).toBeUndefined();
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
