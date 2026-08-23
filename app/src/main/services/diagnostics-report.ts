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
const ENGINE_IDS = new Set(['nemotron', 'whisper']);
const MODEL_IDS = new Set([
  'nvidia/nemotron-speech-streaming-en-0.6b',
  'large-v3-turbo',
  'large-v3',
  'medium',
  'small',
  'tiny',
  'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
  'dropbox-dash/faster-whisper-large-v3-turbo',
  'Systran/faster-whisper-large-v3-turbo',
  'Systran/faster-whisper-large-v3',
  'Systran/faster-whisper-medium',
  'Systran/faster-whisper-small',
  'Systran/faster-whisper-tiny',
]);
const DEVICES = new Set(['auto', 'cpu', 'cuda']);
const COMPUTE_TYPES = new Set(['auto', 'int8', 'int8_float16', 'int16', 'float16', 'float32']);
const RUNTIME_DLLS = new Set(['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']);
const SAFE_VERSION = /^[A-Za-z0-9._+-]{1,40}$/;
const SAFE_WINDOWS_RELEASE = /^[0-9A-Za-z._-]{1,40}$/;
const SAFE_GPU_NAME = /^[A-Za-z0-9 .()_+\-]{1,120}$/;
const SAFE_DRIVER_VERSION = /^[0-9.]{1,30}$/;

const WARNING_MESSAGES: Record<string, string> = {
  vc_redist_missing: 'The required Microsoft Visual C++ runtime was not detected.',
  cuda_unavailable: 'CUDA is unavailable; Eve may use CPU mode.',
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
    if (MODEL_IDS.has(candidate)) return candidate;
  }
  return sawString ? 'custom/local model' : null;
}

function appendWarnings(lines: string[], diagnostics: UnknownRecord | null): void {
  if (!Array.isArray(diagnostics?.warnings) || diagnostics.warnings.length === 0) return;

  const warnings: string[] = [];
  for (const value of diagnostics.warnings.slice(0, 20)) {
    const warning = asRecord(value);
    if (!warning) continue;
    const requestedCode = typeof warning.code === 'string' ? warning.code : '';
    const code = Object.hasOwn(WARNING_MESSAGES, requestedCode) ? requestedCode : 'unknown_warning';
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
  const managedServer = state?.managed === true;

  const appVersion = matchingString(input.appVersion, SAFE_VERSION) ?? 'unknown';
  const windowsRelease = matchingString(input.windowsRelease, SAFE_WINDOWS_RELEASE) ?? 'unknown';
  const architecture = enumString(input.architecture, new Set(['x64', 'arm64', 'ia32'])) ?? 'unknown';
  const managed = typeof state?.managed === 'boolean' ? (state.managed ? 'managed' : 'detected') : 'unknown';
  const serverStatus = enumString(state?.status, SERVER_STATUSES) ?? 'unknown';
  const lines = [
    'Eve diagnostics',
    `App version: ${appVersion}`,
    `Windows: ${windowsRelease} (${architecture})`,
    `Server mode: ${managed}`,
    `Server status: ${serverStatus}`,
  ];

  const serverVersion = managedServer ? matchingString(state?.version, SAFE_VERSION) : null;
  if (serverVersion) lines.push(`Server version: ${serverVersion}`);

  const engine = enumString(engineStatus?.current, ENGINE_IDS);
  if (engine) lines.push(`Engine: ${engine}`);
  const engineState = enumString(engineStatus?.status, ENGINE_STATUSES);
  if (engineState) lines.push(`Engine status: ${engineState}`);
  const model = safeModelLabel(engineInfo, modelDownload);
  if (model) lines.push(`Model: ${model}`);

  const device = enumString(engineInfo?.device, DEVICES);
  if (device) lines.push(`Device: ${device}`);
  const computeType = enumString(engineInfo?.compute_type, COMPUTE_TYPES);
  if (computeType) lines.push(`Compute type: ${computeType}`);
  const cudaActive = yesNo(engineInfo?.cuda_active);
  if (cudaActive) lines.push(`CUDA active: ${cudaActive}`);

  const cudaAvailable = yesNo(cuda?.available);
  if (cudaAvailable) lines.push(`CUDA available: ${cudaAvailable}`);
  const gpuName = managedServer
    ? matchingString(cuda?.name, SAFE_GPU_NAME) ?? matchingString(engineInfo?.gpu_name, SAFE_GPU_NAME)
    : null;
  if (gpuName) lines.push(`GPU: ${gpuName}`);
  const computeCapability = managedServer
    ? matchingString(cuda?.compute_capability, SAFE_DRIVER_VERSION)
    : null;
  if (computeCapability) lines.push(`Compute capability: ${computeCapability}`);

  const driverVersion = managedServer ? matchingString(nvidiaDriver?.version, SAFE_DRIVER_VERSION) : null;
  if (driverVersion) lines.push(`NVIDIA driver: ${driverVersion}`);
  const minimumDriver = managedServer
    ? matchingString(nvidiaDriver?.minimum_version, SAFE_DRIVER_VERSION)
    : null;
  if (minimumDriver) lines.push(`Minimum NVIDIA driver: ${minimumDriver}`);
  const driverSupported = yesNo(nvidiaDriver?.meets_minimum);
  if (driverSupported) lines.push(`Driver meets minimum: ${driverSupported}`);

  const vcInstalled = yesNo(vcRedist?.installed);
  if (vcInstalled) lines.push(`VC++ runtime installed: ${vcInstalled}`);
  if (Array.isArray(vcRedist?.missing)) {
    const missingDlls: string[] = [];
    for (const value of vcRedist.missing.slice(0, 100)) {
      if (typeof value === 'string' && RUNTIME_DLLS.has(value)) missingDlls.push(value);
      if (missingDlls.length === 20) break;
    }
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
