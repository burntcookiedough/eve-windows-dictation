import { describe, expect, test } from 'bun:test';
import { shouldRefreshCommittedSettings } from '../src/renderer/app/engine-settings-transaction.js';
import { readFileSync } from 'node:fs';

describe('Engine settings transaction UI', () => {
  test('keeps a curated candidate staged through failure for Retry or Revert', () => {
    const pending = { engine: 'whisper', whisper_model: 'medium' };
    expect(shouldRefreshCommittedSettings(pending, true, true, true, {
      current: 'nemotron', status: 'error', message: 'Preparation failed.',
    })).toBeFalse();
  });

  test('refreshes committed settings before clearing a ready advanced candidate', () => {
    const pending = {
      whisper_device: 'cuda',
      whisper_compute_type: 'float16',
      whisper_language: 'en',
    };
    expect(shouldRefreshCommittedSettings(pending, true, false, false, {
      current: 'whisper', status: 'ready',
    })).toBeFalse();
    expect(shouldRefreshCommittedSettings(pending, true, true, false, {
      current: 'whisper', status: 'ready',
    })).toBeTrue();
    expect(shouldRefreshCommittedSettings(pending, false, true, false, {
      current: 'whisper', status: 'ready',
    })).toBeFalse();
  });

  test('keeps Retry/Revert transactional in the settings surface', () => {
    const settingsView = readFileSync(
      new URL('../src/renderer/app/views/SettingsView.svelte', import.meta.url),
      'utf8',
    );

    expect(settingsView).toContain('enginePreparationRequested = true');
    expect(settingsView).toContain('void refreshCommittedSettings()');
    expect(settingsView).toContain('if (await loadServerSettings())');
    expect(settingsView).toContain('function revertEngineSettings()');
    expect(settingsView).toContain('pendingEngine = {};');
  });
});
