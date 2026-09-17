import type { EngineStatus, ModelCatalogItem, ModelDownloadState } from '$shared/types';

export interface SpeechModelPreset {
  /** Stable UI key derived from the server-owned model ID. */
  id: string;
  label: string;
  model: string;
  sizeGb: number;
  language: string;
  summary: string;
}

/**
 * Map server-owned presentation metadata into the renderer's view model.
 *
 * There is intentionally no local fallback catalog. A missing or malformed
 * response produces no curated choices; callers keep their raw compatibility
 * controls available for custom and local model paths.
 */
export function speechModelPresetsFromCatalog(
  catalog: readonly ModelCatalogItem[] | undefined,
): SpeechModelPreset[] {
  if (!catalog) return [];
  return catalog.flatMap((item) => {
    if (
      !item || typeof item !== 'object'
      || typeof item.model !== 'string' || item.model.trim().length === 0
      || typeof item.label !== 'string' || item.label.trim().length === 0
      || typeof item.size_gb !== 'number' || !Number.isFinite(item.size_gb) || item.size_gb <= 0
      || !Array.isArray(item.languages)
      || item.languages.length === 0
      || item.languages.some((language) => typeof language !== 'string' || language.trim().length === 0)
    ) {
      return [];
    }
    const language = typeof item.language_label === 'string' && item.language_label.trim().length > 0
      ? item.language_label.trim()
      : item.languages.map((entry) => entry.trim()).join(', ');
    return [{
      id: item.model.trim(),
      label: item.label.trim(),
      model: item.model.trim(),
      sizeGb: item.size_gb,
      language,
      summary: typeof item.summary === 'string' ? item.summary : '',
    }];
  });
}

export function presetPatch(preset: SpeechModelPreset): Record<string, string> {
  // The server already has one supported family. Sending only the model keeps
  // the new settings path independent from legacy engine discovery while old
  // clients can continue using their explicit engine compatibility key.
  return { whisper_model: preset.model };
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

export function stagedPresetFromPending(
  pending: Record<string, unknown>,
  presets: readonly SpeechModelPreset[],
): SpeechModelPreset | null {
  return presets.find((preset) => pending.whisper_model === preset.model) ?? null;
}

export function presetMatchesCurrentEngine(preset: SpeechModelPreset, status: EngineStatus | null): boolean {
  return status?.info?.model === preset.model;
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
