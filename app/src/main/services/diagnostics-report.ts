type UnknownRecord = Record<string, unknown>;

export interface DiagnosticsReportInput {
  appVersion: unknown;
  windowsRelease: unknown;
  architecture: unknown;
  serverState: unknown;
}

const SERVER_STATUSES = new Set(['idle', 'starting', 'running', 'stopping', 'stopped', 'error']);
const ENGINE_STATUSES = new Set(['loading', 'ready', 'error']);
const MODEL_PHASES = new Set(['checking', 'downloading', 'loading', 'ready', 'error']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]{1,80}$/;
const SAFE_MODEL_IDENTIFIER = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;
const SAFE_VERSION = /^[A-Za-z0-9._+-]{1,40}$/;
const SAFE_WINDOWS_RELEASE = /^[0-9A-Za-z._-]{1,40}$/;
const SAFE_GPU_NAME = /^[A-Za-z0-9 .()_+\-]{1,120}$/;
const SAFE_DRIVER_VERSION = /^[0-9.]{1,30}$/;
const SAFE_DLL_NAME = /^[A-Za-z0-9._-]{1,80}\.dll$/i;

const WARNING_MESSAGES: Record<string, string> = {
  vc_redist_missing: 'The required Microsoft Visual C++ runtime was not detected.',
  cuda_unavailable: 'CUDA is unavailable; Murmur may use CPU mode.',
  cuda_dll_missing: 'One or more required CUDA runtime files were not detected.',
  nvidia_driver_old: 'The NVIDIA driver is older than the supported minimum.',
};

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function matchingString(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function enumString(value: unknown, allowed: Set<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function yesNo(value: unknown): string | null {
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : null;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unitIndex = -1;
  do {
    amount /= 1024;
    unitIndex += 1;
  } while (amount >= 1024 && unitIndex < units.length - 1);
  return `${amount.toFixed(2)} ${units[unitIndex]}`;
}

function safeModelLabel(engineInfo: UnknownRecord | null, modelDownload: UnknownRecord | null): string | null {
  const candidates = [engineInfo?.model, engineInfo?.repo_id, modelDownload?.model, modelDownload?.repo_id];
  let sawString = false;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    sawString = true;
    if (candidate.length <= 128 && SAFE_MODEL_IDENTIFIER.test(candidate)) return candidate;
  }
  return sawString ? 'custom/local model' : null;
}

function appendWarnings(lines: string[], diagnostics: UnknownRecord | null): void {
  if (!Array.isArray(diagnostics?.warnings) || diagnostics.warnings.length === 0) return;

  const warnings: string[] = [];
  for (const value of diagnostics.warnings.slice(0, 20)) {
    const warning = asRecord(value);
    if (!warning) continue;
    const code = matchingString(warning.code, /^[a-z0-9_-]{1,64}$/) ?? 'unknown_warning';
    const message = WARNING_MESSAGES[code] ?? 'Additional details omitted for privacy.';
    warnings.push(`- ${code}: ${message}`);
  }

  if (warnings.length > 0) lines.push('Warnings:', ...warnings);
}

export function formatDiagnosticsReport(input: DiagnosticsReportInput): string {
  const state = asRecord(input.serverState);
  const engineStatus = asRecord(state?.engineStatus);
  const engineInfo = asRecord(engineStatus?.info);
  const diagnostics = asRecord(state?.diagnostics);
  const cuda = asRecord(diagnostics?.cuda);
  const nvidiaDriver = asRecord(diagnostics?.nvidia_driver);
  const vcRedist = asRecord(diagnostics?.vc_redist);
  const modelDownload = asRecord(state?.modelDownload);

  const appVersion = matchingString(input.appVersion, SAFE_VERSION) ?? 'unknown';
  const windowsRelease = matchingString(input.windowsRelease, SAFE_WINDOWS_RELEASE) ?? 'unknown';
  const architecture = enumString(input.architecture, new Set(['x64', 'arm64', 'ia32'])) ?? 'unknown';
  const managed = typeof state?.managed === 'boolean' ? (state.managed ? 'managed' : 'external') : 'unknown';
  const serverStatus = enumString(state?.status, SERVER_STATUSES) ?? 'unknown';
  const lines = [
    'Murmur diagnostics',
    `App version: ${appVersion}`,
    `Windows: ${windowsRelease} (${architecture})`,
    `Server mode: ${managed}`,
    `Server status: ${serverStatus}`,
  ];

  const serverVersion = matchingString(state?.version, SAFE_VERSION);
  if (serverVersion) lines.push(`Server version: ${serverVersion}`);

  const engine = matchingString(engineStatus?.current, SAFE_IDENTIFIER);
  if (engine) lines.push(`Engine: ${engine}`);
  const engineState = enumString(engineStatus?.status, ENGINE_STATUSES);
  if (engineState) lines.push(`Engine status: ${engineState}`);
  const model = safeModelLabel(engineInfo, modelDownload);
  if (model) lines.push(`Model: ${model}`);

  const device = matchingString(engineInfo?.device, SAFE_IDENTIFIER);
  if (device) lines.push(`Device: ${device}`);
  const computeType = matchingString(engineInfo?.compute_type, SAFE_IDENTIFIER);
  if (computeType) lines.push(`Compute type: ${computeType}`);
  const cudaActive = yesNo(engineInfo?.cuda_active);
  if (cudaActive) lines.push(`CUDA active: ${cudaActive}`);

  const cudaAvailable = yesNo(cuda?.available);
  if (cudaAvailable) lines.push(`CUDA available: ${cudaAvailable}`);
  const gpuName = matchingString(cuda?.name, SAFE_GPU_NAME) ?? matchingString(engineInfo?.gpu_name, SAFE_GPU_NAME);
  if (gpuName) lines.push(`GPU: ${gpuName}`);
  const computeCapability = matchingString(cuda?.compute_capability, SAFE_DRIVER_VERSION);
  if (computeCapability) lines.push(`Compute capability: ${computeCapability}`);

  const driverVersion = matchingString(nvidiaDriver?.version, SAFE_DRIVER_VERSION);
  if (driverVersion) lines.push(`NVIDIA driver: ${driverVersion}`);
  const minimumDriver = matchingString(nvidiaDriver?.minimum_version, SAFE_DRIVER_VERSION);
  if (minimumDriver) lines.push(`Minimum NVIDIA driver: ${minimumDriver}`);
  const driverSupported = yesNo(nvidiaDriver?.meets_minimum);
  if (driverSupported) lines.push(`Driver meets minimum: ${driverSupported}`);

  const vcInstalled = yesNo(vcRedist?.installed);
  if (vcInstalled) lines.push(`VC++ runtime installed: ${vcInstalled}`);
  if (Array.isArray(vcRedist?.missing)) {
    const missingDlls = vcRedist.missing
      .filter((value): value is string => matchingString(value, SAFE_DLL_NAME) !== null)
      .slice(0, 20);
    if (missingDlls.length > 0) lines.push(`Missing runtime files: ${missingDlls.join(', ')}`);
  }

  const modelPhase = enumString(modelDownload?.phase, MODEL_PHASES);
  if (modelPhase) lines.push(`Model phase: ${modelPhase}`);
  const progress = finiteNonNegative(modelDownload?.progress_percent);
  if (progress !== null) lines.push(`Model progress: ${Math.min(100, progress).toFixed(0)}%`);
  const downloaded = finiteNonNegative(modelDownload?.downloaded_bytes);
  const total = finiteNonNegative(modelDownload?.total_bytes);
  if (downloaded !== null && total !== null) {
    lines.push(`Downloaded: ${formatBytes(downloaded)} / ${formatBytes(total)}`);
  }
  const speed = finiteNonNegative(modelDownload?.bytes_per_second);
  if (speed !== null) lines.push(`Transfer speed: ${formatBytes(speed)}/s`);
  const eta = finiteNonNegative(modelDownload?.eta_seconds);
  if (eta !== null) lines.push(`ETA: ${Math.round(eta)} s`);

  appendWarnings(lines, diagnostics);
  return `${lines.join('\n')}\n`;
}
