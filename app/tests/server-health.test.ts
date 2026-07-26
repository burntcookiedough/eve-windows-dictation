import { describe, expect, test } from 'bun:test';
import {
  isOwnedMurmurServerProcess,
  isMurmurServerCommandLine,
  parseHealthyResponse,
  parseServerPidFile,
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
  const executablePath = 'C:\\Program Files\\Murmur\\resources\\server\\.runtime\\python.exe';
  const commandLine =
    `"${executablePath}" "C:\\Program Files\\Murmur\\resources\\server\\src\\main.py"`;

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

  test('accepts an exact live-process snapshot matching the PID record epoch', () => {
    expect(
      isOwnedMurmurServerProcess(
        {
          processId: 1234,
          creationTimeMs: 10_000,
          executablePath,
          commandLine,
        },
        1234,
        10_250
      )
    ).toBe(true);
  });

  test('rejects stale or reused PID records', () => {
    const snapshot = {
      processId: 1234,
      creationTimeMs: 100_000,
      executablePath,
      commandLine,
    };

    expect(isOwnedMurmurServerProcess(snapshot, 4321, 100_250)).toBe(false);
    expect(isOwnedMurmurServerProcess(snapshot, 1234, 10_000)).toBe(false);
    expect(isOwnedMurmurServerProcess(snapshot, 1234, 200_000)).toBe(false);
  });

  test('rejects unowned executable and command-line combinations', () => {
    expect(
      isOwnedMurmurServerProcess(
        {
          processId: 1234,
          creationTimeMs: 10_000,
          executablePath: 'C:\\Windows\\System32\\notepad.exe',
          commandLine,
        },
        1234,
        10_250
      )
    ).toBe(false);
    expect(
      isOwnedMurmurServerProcess(
        {
          processId: 1234,
          creationTimeMs: 10_000,
          executablePath,
          commandLine: `"${executablePath}" C:\\work\\unrelated.py`,
        },
        1234,
        10_250
      )
    ).toBe(false);
  });

  test('accepts a rapid restart only when the new PID epoch matches', () => {
    const restarted = {
      processId: 1234,
      creationTimeMs: 20_000,
      executablePath,
      commandLine,
    };

    expect(isOwnedMurmurServerProcess(restarted, 1234, 10_250)).toBe(false);
    expect(isOwnedMurmurServerProcess(restarted, 1234, 20_100)).toBe(true);
  });
});

describe('server PID state', () => {
  test('accepts a complete bounded PID record', () => {
    expect(parseServerPidFile({ pid: 1234, port: 51717, startedAt: 10_000 })).toEqual({
      pid: 1234,
      port: 51717,
      startedAt: 10_000,
    });
  });

  test('fails closed on malformed PID state', () => {
    expect(() => parseServerPidFile(null)).toThrow();
    expect(() => parseServerPidFile({ pid: 0, port: 51717, startedAt: 10_000 })).toThrow();
    expect(() => parseServerPidFile({ pid: 1234, port: 65536, startedAt: 10_000 })).toThrow();
    expect(() => parseServerPidFile({ pid: 1234, port: 51717 })).toThrow();
  });
});
