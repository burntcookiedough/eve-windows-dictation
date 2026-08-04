import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { disabledOptionReasons } from '../src/renderer/app/server-setting-options.js';

describe('Server setting option compatibility metadata', () => {
  test('returns visible reasons for disabled options', () => {
    expect(disabledOptionReasons([
      { value: 'auto', label: 'Auto' },
      { value: 'cuda', label: 'CUDA', disabled: true, reason: 'PyTorch CUDA is unavailable.' },
    ])).toEqual(['CUDA: PyTorch CUDA is unavailable.']);
  });

  test('accepts metadata from older servers without disabled fields', () => {
    expect(disabledOptionReasons([
      { value: 'cpu', label: 'CPU' },
    ])).toEqual([]);
  });

  test('renders disabled options and their reasons in compatibility selects', () => {
    const settingsView = readFileSync(
      new URL('../src/renderer/app/views/SettingsView.svelte', import.meta.url),
      'utf8',
    );

    expect(settingsView).toContain('disabled={option.disabled}');
    expect(settingsView).toContain('data-setting-option-reason');
    expect(settingsView).toContain("disabledOptionReasons(getOptions('whisper_compute_type'))");
    expect(settingsView).toContain("disabledOptionReasons(getOptions('whisper_device'))");
    expect(settingsView).toContain("disabledOptionReasons(getOptions('nemotron_device'))");
  });
});
