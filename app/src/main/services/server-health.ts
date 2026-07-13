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

const MODEL_DOWNLOAD_STATUSES = new Set(['missing', 'partial', 'downloading', 'ready', 'error']);
const MODEL_DOWNLOAD_PHASES = new Set(['checking', 'downloading', 'loading', 'ready', 'error']);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function parseModelDownloadState(value: unknown): ModelDownloadState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.model !== 'string' ||
    typeof raw.size_gb !== 'number' ||
    !Number.isFinite(raw.size_gb) ||
    raw.size_gb < 0 ||
    typeof raw.status !== 'string' ||
    !MODEL_DOWNLOAD_STATUSES.has(raw.status)
  ) {
    return undefined;
  }

  const progress = optionalNonNegativeNumber(raw.progress_percent);
  const phase =
    typeof raw.phase === 'string' && MODEL_DOWNLOAD_PHASES.has(raw.phase)
      ? (raw.phase as ModelDownloadState['phase'])
      : undefined;

  return {
    model: raw.model,
    size_gb: raw.size_gb,
    status: raw.status as ModelDownloadState['status'],
    cached: typeof raw.cached === 'boolean' ? raw.cached : undefined,
    detail: optionalString(raw.detail),
    repo_id: optionalString(raw.repo_id),
    path: optionalString(raw.path),
    missing_files: optionalStringArray(raw.missing_files),
    partial_files: optionalStringArray(raw.partial_files),
    updated_at: optionalString(raw.updated_at),
    phase,
    progress_percent: progress === undefined ? undefined : Math.min(100, progress),
    downloaded_bytes: optionalNonNegativeNumber(raw.downloaded_bytes),
    total_bytes: optionalNonNegativeNumber(raw.total_bytes),
    bytes_per_second: optionalNonNegativeNumber(raw.bytes_per_second),
    eta_seconds: optionalNonNegativeNumber(raw.eta_seconds),
    current_file: optionalString(raw.current_file),
    started_at: optionalString(raw.started_at),
  };
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
      parseModelDownloadState(payload.model_download),
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
