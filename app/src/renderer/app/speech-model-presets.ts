import type { EngineStatus, ModelDownloadState } from '$shared/types';

export interface SpeechModelPreset {
  id: 'english-performance' | 'recommended-multilingual' | 'maximum-multilingual-accuracy' | 'lightweight';
  label: string;
  engine: 'nemotron' | 'whisper';
  setting: 'nemotron_model' | 'whisper_model';
  model: string;
  sizeGb: number;
  language: string;
  summary: string;
}

export const SPEECH_MODEL_PRESETS: readonly SpeechModelPreset[] = [
  { id: 'english-performance', label: 'English Performance', engine: 'nemotron', setting: 'nemotron_model', model: 'nvidia/nemotron-speech-streaming-en-0.6b', sizeGb: 2.3, language: 'English only', summary: 'A focused English option for capable hardware.' },
  { id: 'recommended-multilingual', label: 'Recommended Multilingual', engine: 'whisper', setting: 'whisper_model', model: 'large-v3-turbo', sizeGb: 1.5, language: 'Multilingual', summary: 'A balanced multilingual option.' },
  { id: 'maximum-multilingual-accuracy', label: 'Maximum Multilingual Accuracy', engine: 'whisper', setting: 'whisper_model', model: 'large-v3', sizeGb: 2.9, language: 'Multilingual', summary: 'A larger multilingual option for quality-focused use.' },
  { id: 'lightweight', label: 'Lightweight', engine: 'whisper', setting: 'whisper_model', model: 'small', sizeGb: 0.5, language: 'Multilingual', summary: 'A smaller option for constrained hardware.' },
];

export function presetPatch(preset: SpeechModelPreset): Record<string, string> {
  return { engine: preset.engine, [preset.setting]: preset.model };
}

export function hasPendingCompatibilityChanges(
  pending: Record<string, unknown>,
  stagedPreset: SpeechModelPreset | null,
): boolean {
  const stagedPatch = stagedPreset ? presetPatch(stagedPreset) : {};
  return Object.entries(pending).some(([key, value]) => {
    return !Object.prototype.hasOwnProperty.call(stagedPatch, key) || stagedPatch[key] !== value;
  });
}

export function stagedPresetFromPending(pending: Record<string, unknown>): SpeechModelPreset | null {
  return SPEECH_MODEL_PRESETS.find((preset) =>
    pending.engine === preset.engine && pending[preset.setting] === preset.model
  ) ?? null;
}

export function presetMatchesCurrentEngine(preset: SpeechModelPreset, status: EngineStatus | null): boolean {
  if (status?.current !== preset.engine) return false;
  return status.info?.model === preset.model;
}

export function presetMatchesReadyEngine(preset: SpeechModelPreset, status: EngineStatus | null): boolean {
  return presetMatchesCurrentEngine(preset, status) && status?.status === 'ready' && !status.pending;
}

export function presetDownloadLabel(model: ModelDownloadState | undefined, preset: SpeechModelPreset): string {
  if (model?.model !== preset.model) return 'Available';
  if (model.status === 'error') return 'Needs attention';
  if (model.phase === 'checking') return 'Checking';
  if (model.status === 'downloading' || model.phase === 'downloading' || model.phase === 'loading') return 'Preparing';
  if (model.status === 'ready') return 'Installed';
  if (model.status === 'partial') return 'Partial download';
  return 'Available';
}
