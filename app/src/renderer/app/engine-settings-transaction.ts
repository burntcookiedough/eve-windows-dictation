import type { EngineStatus } from '../../shared/types.js';

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
