import type { ServerStatePayload } from '../../shared/types';

type SettingsRecoveryState = Pick<ServerStatePayload, 'status' | 'port' | 'wsUrl' | 'version' | 'engineStatus' | 'modelDownload'>;

export interface EnginePreparationLifecycle {
  pending: Record<string, unknown>;
  requested: boolean;
  active: boolean;
  observed: boolean;
  applying: boolean;
}

export interface ManagedServerPreparationRecovery extends EnginePreparationLifecycle {
  message: string;
}

const MANAGED_SERVER_PREPARATION_INTERRUPTED =
  'The managed speech server stopped while model settings were being prepared. Restart it, then select and apply the model again.';

/**
 * Identify a meaningful server transition without using uptime or byte-level
 * progress, so a failed settings request is retried once per readiness state.
 */
export function serverSettingsStateKey(state: SettingsRecoveryState | null | undefined): string {
  const engine = state?.engineStatus;
  const model = state?.modelDownload;
  return [
    state?.status ?? 'none',
    state?.port ?? '',
    state?.wsUrl ?? '',
    state?.version ?? '',
    engine?.current ?? '',
    engine?.status ?? '',
    engine?.pending?.engine ?? '',
    engine?.pending?.status ?? '',
    model?.model ?? '',
    model?.status ?? '',
    model?.phase ?? '',
  ].join('|');
}

export function shouldRetryServerSettings(
  state: SettingsRecoveryState | null | undefined,
  connected: boolean,
  loading: boolean,
  lastAttemptKey: string | null,
): boolean {
  if (!state || state.status !== 'running' || connected || loading) return false;
  return serverSettingsStateKey(state) !== lastAttemptKey;
}

export function shouldClearServerSettings(
  state: SettingsRecoveryState | null | undefined,
): boolean {
  return state !== null && state !== undefined && state.status !== 'running';
}

/**
 * Clear every renderer-only preparation flag when the managed server leaves
 * running state. Keeping a staged model after that transition would leave the
 * Settings surface stuck on Preparing with no server-side transaction alive.
 */
export function recoverInterruptedManagedPreparation(
  state: SettingsRecoveryState | null | undefined,
  lifecycle: EnginePreparationLifecycle,
): ManagedServerPreparationRecovery | null {
  if (!shouldClearServerSettings(state)) return null;

  const interrupted = lifecycle.requested
    || lifecycle.active
    || lifecycle.observed
    || lifecycle.applying
    || Object.keys(lifecycle.pending).length > 0;

  return {
    pending: {},
    requested: false,
    active: false,
    observed: false,
    applying: false,
    message: interrupted ? MANAGED_SERVER_PREPARATION_INTERRUPTED : '',
  };
}
