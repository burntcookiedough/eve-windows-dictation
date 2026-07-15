import { describe, expect, test } from 'bun:test';
import { formatDiagnosticsReport } from '../src/main/services/diagnostics-report';

function report(serverState: unknown): string {
  return formatDiagnosticsReport({
    appVersion: '0.6.2',
    windowsRelease: '10.0.26100',
    architecture: 'x64',
    serverState,
  });
}

describe('privacy-safe diagnostics report', () => {
  test('formats an allowlisted healthy CUDA summary deterministically', () => {
    expect(report({
      status: 'running',
      managed: true,
      version: '0.6.2',
      engineStatus: {
        current: 'parakeet',
        status: 'ready',
        info: {
          model: 'nvidia/parakeet-tdt-0.6b-v2',
          device: 'cuda',
          compute_type: 'float16',
          cuda_active: true,
        },
      },
      diagnostics: {
        cuda: { available: true, name: 'NVIDIA GeForce RTX 4060', compute_capability: '8.9' },
        nvidia_driver: { version: '560.94', minimum_version: '525.0', meets_minimum: true },
        vc_redist: { installed: true },
        warnings: [],
      },
    })).toBe(`Murmur diagnostics
App version: 0.6.2
Windows: 10.0.26100 (x64)
Server mode: managed
Server status: running
Server version: 0.6.2
Engine: parakeet
Engine status: ready
Model: nvidia/parakeet-tdt-0.6b-v2
Device: cuda
Compute type: float16
CUDA active: yes
CUDA available: yes
GPU: NVIDIA GeForce RTX 4060
Compute capability: 8.9
NVIDIA driver: 560.94
Minimum NVIDIA driver: 525.0
Driver meets minimum: yes
VC++ runtime installed: yes
`);
  });

  test('includes bounded progress metrics without current file details', () => {
    const output = report({
      status: 'starting',
      managed: true,
      modelDownload: {
        model: 'large-v3-turbo',
        phase: 'downloading',
        progress_percent: 104.7,
        downloaded_bytes: 1024,
        total_bytes: 2048,
        bytes_per_second: 512,
        eta_seconds: 12.4,
        current_file: 'C:\\Users\\Alice\\secret-model.bin',
      },
    });

    expect(output).toContain('Model phase: downloading');
    expect(output).toContain('Model progress: 100%');
    expect(output).toContain('Downloaded: 1.00 KB / 2.00 KB');
    expect(output).toContain('Transfer speed: 512 B/s');
    expect(output).toContain('ETA: 12 s');
    expect(output).not.toContain('Alice');
    expect(output).not.toContain('secret-model.bin');
  });

  test('canonicalizes warning text and omits all raw private fields', () => {
    const sensitiveValues = [
      'C:\\Users\\Alice\\models\\private',
      'Bearer top-secret-token',
      'private transcript words',
      'clipboard secret',
      'https://private.example/action',
    ];
    const output = report({
      status: 'error',
      managed: false,
      pid: 1234,
      port: 51717,
      wsUrl: 'ws://private-host:51717/ws',
      error: sensitiveValues[0],
      engineStatus: {
        current: 'whisper',
        status: 'error',
        message: sensitiveValues[1],
        info: { model: sensitiveValues[0], model_path: sensitiveValues[0] },
      },
      modelDownload: { model: sensitiveValues[0], detail: sensitiveValues[2], path: sensitiveValues[0] },
      diagnostics: {
        cuda: { available: false, reason: sensitiveValues[3] },
        cuda_dlls: { available: false, detail: sensitiveValues[0] },
        warnings: [
          { code: 'cuda_unavailable', message: sensitiveValues[2], action: sensitiveValues[1] },
          { code: 'unexpected_probe', message: sensitiveValues[3], url: sensitiveValues[4] },
        ],
      },
      logs: sensitiveValues,
      history: sensitiveValues[2],
    });

    expect(output).toContain('Server mode: external');
    expect(output).toContain('Model: custom/local model');
    expect(output).toContain('- cuda_unavailable: CUDA is unavailable; Murmur may use CPU mode.');
    expect(output).toContain('- unexpected_probe: Additional details omitted for privacy.');
    for (const sensitive of sensitiveValues) expect(output).not.toContain(sensitive);
    expect(output).not.toContain('51717');
    expect(output).not.toContain('1234');
  });

  test('drops malformed nested values and unsafe missing-file paths', () => {
    const output = formatDiagnosticsReport({
      appVersion: '0.6.2\nInjected',
      windowsRelease: 'C:\\Users\\Alice',
      architecture: 'mips',
      serverState: {
        status: 'almost-running',
        managed: 'yes',
        engineStatus: { current: 'bad/value', status: 'ready', info: { gpu_name: 'C:\\secret' } },
        diagnostics: {
          vc_redist: { installed: 'yes', missing: ['vcruntime140.dll', 'C:\\secret.dll'] },
          warnings: [{ code: 'BAD CODE', message: 'private details' }, null],
        },
        modelDownload: { progress_percent: Number.NaN, eta_seconds: -5 },
      },
    });

    expect(output).toContain('App version: unknown');
    expect(output).toContain('Windows: unknown (unknown)');
    expect(output).toContain('Server mode: unknown');
    expect(output).toContain('Server status: unknown');
    expect(output).toContain('Engine status: ready');
    expect(output).toContain('Missing runtime files: vcruntime140.dll');
    expect(output).toContain('- unknown_warning: Additional details omitted for privacy.');
    expect(output).not.toContain('Alice');
    expect(output).not.toContain('secret.dll');
    expect(output).not.toContain('private details');
    expect(output).not.toContain('Model progress:');
    expect(output).not.toContain('ETA:');
  });

  test('handles an unavailable server snapshot', () => {
    expect(report(null)).toContain(`Server mode: unknown
Server status: unknown
`);
  });
});
