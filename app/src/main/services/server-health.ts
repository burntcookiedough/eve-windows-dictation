import type {
  EngineStatus,
  ModelDownloadState,
  ServerDiagnostics,
} from '../../shared/types.js';

export interface HealthState {
  healthy: boolean;
  version?: string;
  diagnostics?: ServerDiagnostics;
  modelDownload?: ModelDownloadState;
  engineStatus?: EngineStatus;
}

export function parseHealthyResponse(data: unknown): HealthState {
  if (!data || typeof data !== 'object') return { healthy: false };

  const payload = data as Record<string, unknown>;
  const rawEngine =
    payload.engine && typeof payload.engine === 'object'
      ? (payload.engine as Record<string, unknown>)
      : undefined;
  const engineStatus =
    rawEngine &&
    typeof rawEngine.current === 'string' &&
    (rawEngine.status === 'loading' || rawEngine.status === 'ready' || rawEngine.status === 'error')
      ? (rawEngine as unknown as EngineStatus)
      : undefined;

  return {
    healthy: true,
    version: typeof payload.version === 'string' ? payload.version : undefined,
    diagnostics:
      payload.diagnostics && typeof payload.diagnostics === 'object'
        ? (payload.diagnostics as ServerDiagnostics)
        : undefined,
    modelDownload:
      payload.model_download && typeof payload.model_download === 'object'
        ? (payload.model_download as ModelDownloadState)
        : undefined,
    engineStatus,
  };
}

export function isMurmurServerCommandLine(commandLine: string): boolean {
  const normalized = commandLine.replaceAll('/', '\\').toLowerCase();
  return (
    /python(?:w)?\.exe/.test(normalized) &&
    /(?:^|\s|["'])[^"']*\\server\\src\\main\.py(?:["']|\s|$)/.test(normalized)
  );
}
