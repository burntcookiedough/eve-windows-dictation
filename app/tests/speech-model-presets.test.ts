import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SPEECH_MODEL_PRESETS, presetDownloadLabel, presetMatchesEngine, presetPatch } from '../src/renderer/app/speech-model-presets';

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
    expect(presetMatchesEngine(preset, { current: 'whisper', status: 'loading', pending: { engine: 'whisper' } })).toBeFalse();
    expect(presetMatchesEngine(preset, { current: 'whisper', status: 'ready', info: { id: 'whisper', name: 'Faster-Whisper', model: 'large-v3-turbo', languages: [], model_size_gb: 1.5 } })).toBeTrue();
    expect(presetDownloadLabel({ model: 'large-v3-turbo', size_gb: 1.5, status: 'partial' }, preset)).toBe('Partial download');
  });

  test('keeps selection and preparation explicit in the Settings surface', () => {
    const settings = readFileSync(new URL('../src/renderer/app/views/SettingsView.svelte', import.meta.url), 'utf8');
    const chooser = readFileSync(new URL('../src/renderer/app/components/SpeechModelChooser.svelte', import.meta.url), 'utf8');
    expect(chooser).toContain('type="radio"');
    expect(chooser).toContain('Apply and prepare model confirms the change.');
    expect(settings).toContain('Apply and prepare model');
    expect(settings).toContain('serverStatusState');
    expect(settings).not.toContain('async function pollEngineStatus');
    expect(settings).toContain("'nemotron_model'");
    expect(settings).toContain("'whisper_language'");
    const config = readFileSync(new URL('../../server/src/config.py', import.meta.url), 'utf8');
    expect(config).toContain('"medium"');
    expect(config).toContain('"tiny"');
    expect(settings).toContain('whisper_compute_type');
  });
});
