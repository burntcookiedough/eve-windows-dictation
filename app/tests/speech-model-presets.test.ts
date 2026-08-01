import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SPEECH_MODEL_PRESETS, presetDownloadLabel, presetMatchesCurrentEngine, presetMatchesReadyEngine, presetPatch, stagedPresetFromPending } from '../src/renderer/app/speech-model-presets';

describe('speech model presets', () => {
  test('keeps the four exact supported mappings and factual established sizes', () => {
    expect(SPEECH_MODEL_PRESETS.map(({ label, engine, model, sizeGb }) => ({ label, engine, model, sizeGb }))).toEqual([
      { label: 'English Performance', engine: 'nemotron', model: 'nvidia/nemotron-speech-streaming-en-0.6b', sizeGb: 2.3 },
      { label: 'Recommended Multilingual', engine: 'whisper', model: 'large-v3-turbo', sizeGb: 1.5 },
      { label: 'Maximum Multilingual Accuracy', engine: 'whisper', model: 'large-v3', sizeGb: 2.9 },
      { label: 'Lightweight', engine: 'whisper', model: 'small', sizeGb: 0.5 },
    ]);
    expect(presetPatch(SPEECH_MODEL_PRESETS[0])).toEqual({ engine: 'nemotron', nemotron_model: 'nvidia/nemotron-speech-streaming-en-0.6b' });
    expect(presetPatch(SPEECH_MODEL_PRESETS[1])).toEqual({ engine: 'whisper', whisper_model: 'large-v3-turbo' });
  });

  test('promotes a selected preset only when its actual engine status is ready', () => {
    const preset = SPEECH_MODEL_PRESETS[1];
    const oldWhisperDuringCrossEngineSwap = { current: 'whisper', status: 'loading', pending: { engine: 'nemotron' }, info: { id: 'whisper', name: 'Faster-Whisper', model: 'large-v3-turbo', languages: [], model_size_gb: 1.5 } };
    const oldTurboDuringSameEngineSwap = { current: 'whisper', status: 'loading', pending: { engine: 'whisper' }, info: { id: 'whisper', name: 'Faster-Whisper', model: 'large-v3-turbo', languages: [], model_size_gb: 1.5 } };
    expect(presetMatchesCurrentEngine(preset, oldWhisperDuringCrossEngineSwap)).toBeTrue();
    expect(presetMatchesReadyEngine(preset, oldWhisperDuringCrossEngineSwap)).toBeFalse();
    expect(presetMatchesCurrentEngine(preset, oldTurboDuringSameEngineSwap)).toBeTrue();
    expect(presetMatchesReadyEngine(preset, oldTurboDuringSameEngineSwap)).toBeFalse();
    expect(presetMatchesReadyEngine(preset, { current: 'whisper', status: 'ready', info: { id: 'whisper', name: 'Faster-Whisper', model: 'large-v3-turbo', languages: [], model_size_gb: 1.5 } })).toBeTrue();
    expect(presetDownloadLabel({ model: 'large-v3-turbo', size_gb: 1.5, status: 'partial' }, preset)).toBe('Partial download');
  });

  test('keeps selection and preparation explicit in the Settings surface', () => {
    const settings = readFileSync(new URL('../src/renderer/app/views/SettingsView.svelte', import.meta.url), 'utf8');
    const chooser = readFileSync(new URL('../src/renderer/app/components/SpeechModelChooser.svelte', import.meta.url), 'utf8');
    expect(chooser).toContain('type="radio"');
    expect(chooser).toContain('Apply and prepare model confirms the change.');
    expect(settings).toContain('Apply and prepare model');
    expect(settings).toContain('serverStatusState');
    expect(settings).toContain('shouldRetryServerSettings');
    expect(settings).toContain('shouldClearServerSettings');
    expect(settings).toContain('serverSettingsLoading');
    expect(settings).not.toContain('async function pollEngineStatus');
    expect(settings).toContain('!!sharedEngineStatus?.message');
    expect(settings).toContain("sharedEngineStatus?.pending?.status === 'error'");
    expect(settings).toContain('sharedEngineStatus?.pending?.message ?? sharedEngineStatus?.message');
    expect(settings).toContain("'Retry preparation'");
    expect(settings).toContain("'nemotron_model'");
    expect(settings).toContain("'whisper_language'");
    const config = readFileSync(new URL('../../server/src/config.py', import.meta.url), 'utf8');
    expect(config).toContain('"medium"');
    expect(config).toContain('"tiny"');
    expect(settings).toContain('whisper_compute_type');
    expect(settings).toContain('Raw Whisper compatibility model, including Medium and Tiny');
    expect(settings).toContain('!stagedPreset');
    expect(settings).toContain('const { engine: _engine, [stagedPreset.setting]: _model, ...advancedPending }');
  });

  test('routes only an actual staged preset through model preparation and preserves advanced pending values on revert', () => {
    expect(stagedPresetFromPending({ whisper_compute_type: 'int8' })).toBeNull();
    expect(stagedPresetFromPending({ engine: 'whisper', whisper_model: 'medium' })).toBeNull();
    expect(stagedPresetFromPending({ engine: 'whisper', whisper_model: 'large-v3-turbo', whisper_compute_type: 'int8' })?.id).toBe('recommended-multilingual');
    expect(stagedPresetFromPending({ engine: 'nemotron', nemotron_model: 'nvidia/nemotron-speech-streaming-en-0.6b', nemotron_device: 'cuda' })?.id).toBe('english-performance');
  });
});
