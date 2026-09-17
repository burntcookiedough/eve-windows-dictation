import type { EngineStatus, ModelDownloadState } from '$shared/types';

export interface SpeechModelPreset {
  id: 'recommended-multilingual' | 'maximum-multilingual-accuracy' | 'lightweight';
  label: string;
  model: string;
  sizeGb: number;
  language: string;
  summary: string;
}

export const SPEECH_MODEL_PRESETS: readonly SpeechModelPreset[] = [
  { id: 'recommended-multilingual', label: 'Recommended Multilingual', model: 'large-v3-turbo', sizeGb: 1.5, language: 'Multilingual', summary: 'A balanced multilingual option.' },
  { id: 'maximum-multilingual-accuracy', label: 'Maximum Multilingual Accuracy', model: 'large-v3', sizeGb: 2.9, language: 'Multilingual', summary: 'A larger multilingual option for quality-focused use.' },
  { id: 'lightweight', label: 'Lightweight', model: 'small', sizeGb: 0.5, language: 'Multilingual', summary: 'A smaller option for constrained hardware.' },
];

export function presetPatch(preset: SpeechModelPreset): Record<string, string> {
  return { engine: 'whisper', whisper_model: preset.model };
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
    pending.engine === 'whisper' && pending.whisper_model === preset.model
  ) ?? null;
}

export function presetMatchesCurrentEngine(preset: SpeechModelPreset, status: EngineStatus | null): boolean {
  if (status?.current !== 'whisper') return false;
  return status.info?.model === preset.model;
}

export function presetMatchesReadyEngine(preset: SpeechModelPreset, status: EngineStatus | null): boolean {
  return presetMatchesCurrentEngine(preset, status) && status?.status === 'ready' && !status.pending;
}

export function presetMatchesPreparationTarget(
  preset: SpeechModelPreset,
  status: EngineStatus | null,
  modelDownload: ModelDownloadState | undefined,
): boolean {
  const pendingModel = status?.pending?.model;
  if (typeof pendingModel === 'string' && pendingModel.trim().length > 0) {
    return pendingModel === preset.model;
  }
  return modelDownload?.model === preset.model;
}

export function presetIsPreparing(
  preset: SpeechModelPreset,
  status: EngineStatus | null,
  modelDownload: ModelDownloadState | undefined,
): boolean {
  if (!presetMatchesPreparationTarget(preset, status, modelDownload)) return false;
  if (typeof status?.pending?.model === 'string' && status.pending.model.trim().length > 0) {
    return status.pending.status === 'loading';
  }
  return modelDownload?.status === 'partial'
    || modelDownload?.status === 'downloading'
    || modelDownload?.phase === 'checking'
    || modelDownload?.phase === 'downloading'
    || modelDownload?.phase === 'loading';
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
