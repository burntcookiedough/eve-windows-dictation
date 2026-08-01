import type { ServerStatePayload } from '../../shared/types';

type SettingsRecoveryState = Pick<ServerStatePayload, 'status' | 'port' | 'version' | 'engineStatus' | 'modelDownload'>;

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

export function shouldClearServerSettings(state: SettingsRecoveryState | null | undefined): boolean {
  return state !== null && state !== undefined && state.status !== 'running';
}
