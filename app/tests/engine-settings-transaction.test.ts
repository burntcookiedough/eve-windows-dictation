import { describe, expect, test } from 'bun:test';
import { enginePreparationPhase, shouldDisableEngineRevert, shouldRefreshCommittedSettings } from '../src/renderer/app/engine-settings-transaction.js';
import { readFileSync } from 'node:fs';

describe('Engine settings transaction UI', () => {
  test('keeps a curated candidate staged through failure for Retry or Revert', () => {
    const pending = { engine: 'whisper', whisper_model: 'medium' };
    expect(shouldRefreshCommittedSettings(pending, true, true, true, {
      current: 'nemotron', status: 'error', message: 'Preparation failed.',
    })).toBeFalse();
    expect(shouldDisableEngineRevert(true)).toBeTrue();
    expect(shouldDisableEngineRevert(false)).toBeFalse();
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

  test('treats a refreshed terminal failure as complete when loading was missed', () => {
    expect(enginePreparationPhase({
      current: 'whisper', status: 'ready', message: 'Preparation failed.',
    })).toBe('failed');
    expect(shouldDisableEngineRevert(false)).toBeFalse();
  });

  test('keeps Retry/Revert transactional in the settings surface', () => {
    const settingsView = readFileSync(
      new URL('../src/renderer/app/views/SettingsView.svelte', import.meta.url),
      'utf8',
    );

    expect(settingsView).toContain('enginePreparationRequested = true');
    expect(settingsView).toContain('await confirmEnginePreparationStatus()');
    expect(settingsView).toContain('void refreshCommittedSettings()');
    expect(settingsView).toContain('if (await loadServerSettings())');
    expect(settingsView).toContain('function revertEngineSettings()');
    expect(settingsView).toContain('pendingEngine = {};');
    expect(settingsView).toContain('disabled={engineApplying || engineRevertDisabled}');
    expect(settingsView).toContain('recoverInterruptedManagedPreparation');
    expect(settingsView).toContain('data-engine-preparation-interrupted');
  });
});
