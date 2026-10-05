import type { EngineStatus } from '../../shared/types.js';

export type EnginePreparationPhase = 'preparing' | 'failed' | 'ready' | 'unknown';

export function enginePreparationPhase(
  status: EngineStatus | null,
): EnginePreparationPhase {
  if (!status) return 'unknown';
  if (status.status === 'error' || status.pending?.status === 'error' || status.message) return 'failed';
  if (status.status === 'loading' || status.pending) return 'preparing';
  if (status.status === 'ready') return 'ready';
  return 'unknown';
}

export function shouldDisableEngineRevert(
  preparationActive: boolean,
): boolean {
  return preparationActive;
}

export function mergeEngineSettingsPatch(
  pending: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...pending, ...patch };
}

export function clearAppliedEngineSettings(
  pending: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(pending).filter(([key, value]) =>
    !Object.prototype.hasOwnProperty.call(patch, key) || !Object.is(value, patch[key])
  ));
}

export function engineSettingsPatchMatches(
  patch: Record<string, unknown>,
  settings: Record<string, { value: unknown }> | null,
): boolean {
  return Object.entries(patch).every(([key, value]) => settings?.[key]?.value === value);
}

export function shouldRefreshCommittedSettings(
  pending: Record<string, unknown>,
  preparationRequested: boolean,
  preparationObserved: boolean,
  preparationFailed: boolean,
  status: EngineStatus | null,
): boolean {
  return preparationRequested
    && preparationObserved
    && !preparationFailed
    && Object.keys(pending).length > 0
    && status?.status === 'ready'
    && !status.pending;
}
