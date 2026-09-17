import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SPEECH_MODEL_PRESETS, hasPendingCompatibilityChanges, presetDownloadLabel, presetIsPreparing, presetMatchesCurrentEngine, presetMatchesReadyEngine, presetPatch, stagedPresetFromPending } from '../src/renderer/app/speech-model-presets';

describe('speech model presets', () => {
  test('keeps the three exact shipped mappings and factual established sizes', () => {
    expect(SPEECH_MODEL_PRESETS.map(({ id }) => id)).toEqual([
      'recommended-multilingual',
      'maximum-multilingual-accuracy',
      'lightweight',
    ]);
    expect(SPEECH_MODEL_PRESETS.map(({ label, model, sizeGb }) => ({ label, model, sizeGb }))).toEqual([
      { label: 'Recommended Multilingual', model: 'large-v3-turbo', sizeGb: 1.5 },
      { label: 'Maximum Multilingual Accuracy', model: 'large-v3', sizeGb: 2.9 },
      { label: 'Lightweight', model: 'small', sizeGb: 0.5 },
    ]);
    expect(presetPatch(SPEECH_MODEL_PRESETS[0])).toEqual({ engine: 'whisper', whisper_model: 'large-v3-turbo' });
    expect(presetPatch(SPEECH_MODEL_PRESETS[1])).toEqual({ engine: 'whisper', whisper_model: 'large-v3' });
  });

  test('does not warn for a pure staged preset patch but warns for an additional pending model', () => {
    const preset = SPEECH_MODEL_PRESETS[0];
    const patch = presetPatch(preset);
    expect(hasPendingCompatibilityChanges(patch, preset)).toBeFalse();
    expect(hasPendingCompatibilityChanges({ ...patch, whisper_model: 'medium' }, preset)).toBeTrue();
  });

  test('warns when a staged preset model has a different pending value', () => {
    const preset = SPEECH_MODEL_PRESETS[1];
    expect(hasPendingCompatibilityChanges(presetPatch(preset), preset)).toBeFalse();
    expect(hasPendingCompatibilityChanges({ ...presetPatch(preset), whisper_model: 'medium' }, preset)).toBeTrue();
  });

  test('promotes a selected preset only when its actual engine status is ready', () => {
    const preset = SPEECH_MODEL_PRESETS[0];
    const previousModelDuringReplacement = { current: 'whisper', status: 'loading', pending: { engine: 'whisper' }, info: { id: 'whisper', name: 'Faster-Whisper', model: 'large-v3-turbo', languages: [], model_size_gb: 1.5 } };
    expect(presetMatchesCurrentEngine(preset, previousModelDuringReplacement)).toBeTrue();
    expect(presetMatchesReadyEngine(preset, previousModelDuringReplacement)).toBeFalse();
    expect(presetMatchesReadyEngine(preset, { current: 'whisper', status: 'ready', info: { id: 'whisper', name: 'Faster-Whisper', model: 'large-v3-turbo', languages: [], model_size_gb: 1.5 } })).toBeTrue();
    expect(presetDownloadLabel({ model: 'large-v3-turbo', size_gb: 1.5, status: 'partial' }, preset)).toBe('Partial download');
  });

  test('attributes preparation to the pending model and ignores stale download state', () => {
    const previous = SPEECH_MODEL_PRESETS[0]!;
    const target = SPEECH_MODEL_PRESETS[1]!;
    const replacing = {
      current: 'whisper' as const,
      status: 'loading' as const,
      pending: { engine: 'whisper', model: target.model, status: 'loading' as const },
    };
    const staleDownload = { model: previous.model, size_gb: previous.sizeGb, status: 'downloading' as const };

    expect(presetIsPreparing(target, replacing, staleDownload)).toBeTrue();
    expect(presetIsPreparing(previous, replacing, staleDownload)).toBeFalse();
  });

  test('uses the download target only as a scoped fallback for older servers', () => {
    const target = SPEECH_MODEL_PRESETS[1]!;
    const loadingWithoutModel = {
      current: 'whisper' as const,
      status: 'loading' as const,
      pending: { engine: 'whisper', status: 'loading' as const },
    };
    const staleDownload = { model: SPEECH_MODEL_PRESETS[0]!.model, size_gb: 1.5, status: 'downloading' as const };
    const targetDownload = { model: target.model, size_gb: target.sizeGb, status: 'downloading' as const };

    expect(presetIsPreparing(target, loadingWithoutModel, staleDownload)).toBeFalse();
    expect(presetIsPreparing(target, loadingWithoutModel, targetDownload)).toBeTrue();
  });

  test('keeps selection and preparation explicit in the Settings surface', () => {
    const settings = readFileSync(new URL('../src/renderer/app/views/SettingsView.svelte', import.meta.url), 'utf8');
    const settingsMarkup = settings.replace(/<script[\s\S]*?<\/script>/, '');
    const chooser = readFileSync(new URL('../src/renderer/app/components/SpeechModelChooser.svelte', import.meta.url), 'utf8');
    const transaction = readFileSync(new URL('../src/renderer/app/engine-settings-transaction.ts', import.meta.url), 'utf8');
    expect(chooser).toContain('type="radio"');
    expect(chooser).toContain('name={`speech-model-preset-${componentId}`}');
    expect(chooser).toContain('Apply and prepare model confirms the change.');
    expect(settings).toContain('Apply and prepare model');
    expect(settings).toContain("getSettingValue<string>('whisper_model') === preset.model");
    expect(settings).toContain('serverStatusState');
    expect(settings).toContain('shouldRetryServerSettings');
    expect(settings).toContain('shouldClearServerSettings');
    expect(settings).toContain('serverSettingsLoading');
    expect(settings).not.toContain('async function pollEngineStatus');
    expect(settings).toContain("enginePreparationPhase(sharedEngineStatus) === 'failed'");
    expect(transaction).toContain("status.pending?.status === 'error'");
    expect(settings).toContain('sharedEngineStatus?.pending?.message ?? sharedEngineStatus?.message');
    expect(settings).toContain("'Retry preparation'");
    expect(settingsMarkup).not.toContain('Nemotron');
    expect(settingsMarkup).not.toContain('nemotron_model');
    expect(settingsMarkup).not.toContain('nemotron_device');
    expect(settingsMarkup).not.toContain('unload_before_swap');
    expect(settings).toContain("'whisper_language'");
    const config = readFileSync(new URL('../../server/src/config.py', import.meta.url), 'utf8');
    expect(config).toContain('"medium"');
    expect(config).toContain('"tiny"');
    expect(settings).toContain('whisper_compute_type');
    expect(settings).toContain('Raw Whisper compatibility model, including Medium and Tiny');
    expect(settings).toContain('!stagedPreset');
    expect(settings).toContain('function revertEngineSettings()');
    expect(settings).toContain('pendingEngine = {};');
  });

  test('routes only an actual staged preset through model preparation and clears the full candidate on revert', () => {
    expect(stagedPresetFromPending({ whisper_compute_type: 'int8' })).toBeNull();
    expect(stagedPresetFromPending({ engine: 'whisper', whisper_model: 'medium' })).toBeNull();
    expect(stagedPresetFromPending({ engine: 'whisper', whisper_model: 'large-v3-turbo', whisper_compute_type: 'int8' })?.id).toBe('recommended-multilingual');
    expect(stagedPresetFromPending({ engine: 'whisper', whisper_model: 'custom/local-model', whisper_device: 'cuda' })).toBeNull();
  });
});
