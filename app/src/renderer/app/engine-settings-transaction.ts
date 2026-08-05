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
