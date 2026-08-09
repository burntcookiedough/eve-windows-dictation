import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  disabledOptionReasons,
  optionsForDraftWhisperDevice,
} from '../src/renderer/app/server-setting-options.js';

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

  test.each([
    ['cpu', true, true],
    ['cuda', false, false],
  ])('uses the draft %s device for precision availability', (device, float16Disabled, mixedDisabled) => {
    const options = optionsForDraftWhisperDevice([
      {
        value: 'float16',
        label: 'Float16',
        disabled: true,
        reason: 'Not supported by CTranslate2 on cpu.',
        device_compatibility: {
          cpu: { disabled: true, reason: 'Not supported by CTranslate2 on cpu.' },
          cuda: { disabled: false },
        },
      },
      {
        value: 'int8_float16',
        label: 'Int8+Float16',
        disabled: true,
        reason: 'Not supported by CTranslate2 on cpu.',
        device_compatibility: {
          cpu: { disabled: true, reason: 'Not supported by CTranslate2 on cpu.' },
          cuda: { disabled: false },
        },
      },
    ], device);

    expect(options[0].disabled).toBe(float16Disabled);
    expect(options[1].disabled).toBe(mixedDisabled);
  });

  test('renders disabled options and their reasons in compatibility selects', () => {
    const settingsView = readFileSync(
      new URL('../src/renderer/app/views/SettingsView.svelte', import.meta.url),
      'utf8',
    );
    const dropdown = readFileSync(
      new URL('../src/renderer/app/components/EveDropdown.svelte', import.meta.url),
      'utf8',
    );

    expect(settingsView).toContain('<EveDropdown');
    expect(settingsView).toContain('toDropdownOptions');
    expect(dropdown).toContain('disabled={option.disabled}');
    expect(dropdown).toContain('aria-disabled={option.disabled || undefined}');
    expect(dropdown).toContain('aria-describedby={option.description ?');
    expect(dropdown).toContain('if (!option || option.disabled) return;');
    expect(settingsView).toContain('data-setting-option-reason');
    expect(settingsView).toContain('getWhisperComputeOptions()');
    expect(settingsView).toContain("disabledOptionReasons(getWhisperComputeOptions())");
    expect(settingsView).toContain("disabledOptionReasons(getOptions('whisper_device'))");
    expect(settingsView).toContain("disabledOptionReasons(getOptions('nemotron_device'))");
  });
});
