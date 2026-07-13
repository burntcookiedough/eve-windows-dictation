import type { ModelDownloadState } from './types.js';

export interface ModelProgressView {
  phase: 'checking' | 'downloading' | 'loading';
  stepLabel: string;
  title: string;
  summary: string;
  metrics: string | null;
  progressPercent: number | null;
}

export function formatProgressBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  const digits = unitIndex >= 3 ? 2 : unitIndex >= 1 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatProgressDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'less than a minute';
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`;
}

function activePhase(
  state: ModelDownloadState
): ModelProgressView['phase'] | null {
  if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'loading') {
    return state.phase;
  }
  return state.status === 'downloading' ? 'downloading' : null;
}

export function shouldShowModelProgress(state?: ModelDownloadState): boolean {
  return state !== undefined && activePhase(state) !== null;
}

export function getModelProgressView(
  state?: ModelDownloadState
): ModelProgressView | null {
  if (!state) return null;
  const phase = activePhase(state);
  if (!phase) return null;

  const rawPercent = state.progress_percent;
  const progressPercent =
    typeof rawPercent === 'number' && Number.isFinite(rawPercent)
      ? Math.max(0, Math.min(100, rawPercent))
      : null;

  if (phase === 'checking') {
    return {
      phase,
      stepLabel: 'Step 1 of 3',
      title: `Checking ${state.model}`,
      summary: 'Looking for an existing model download.',
      metrics: null,
      progressPercent: null,
    };
  }

  if (phase === 'loading') {
    return {
      phase,
      stepLabel: 'Step 3 of 3',
      title: `Preparing ${state.model}`,
      summary: 'Download complete. Loading the speech model into memory.',
      metrics: 'This step depends on disk and GPU speed.',
      progressPercent: 100,
    };
  }

  const downloaded = state.downloaded_bytes;
  const total = state.total_bytes;
  const metricParts: string[] = [];
  if (
    typeof downloaded === 'number' &&
    Number.isFinite(downloaded) &&
    typeof total === 'number' &&
    Number.isFinite(total) &&
    total > 0
  ) {
    metricParts.push(`${formatProgressBytes(downloaded)} of ${formatProgressBytes(total)}`);
  }
  if (progressPercent !== null) {
    metricParts.push(`${Math.round(progressPercent)}%`);
  }
  if (
    typeof state.bytes_per_second === 'number' &&
    Number.isFinite(state.bytes_per_second) &&
    state.bytes_per_second > 0
  ) {
    metricParts.push(`${formatProgressBytes(state.bytes_per_second)}/s`);
  }
  if (
    typeof state.eta_seconds === 'number' &&
    Number.isFinite(state.eta_seconds) &&
    state.eta_seconds >= 0
  ) {
    metricParts.push(`About ${formatProgressDuration(state.eta_seconds)} remaining`);
  } else {
    metricParts.push('Estimating time remaining…');
  }

  return {
    phase,
    stepLabel: 'Step 2 of 3',
    title: `Downloading ${state.model}`,
    summary: state.current_file
      ? `Fetching ${state.current_file}. Keep Murmur open.`
      : 'Fetching the speech model. Keep Murmur open.',
    metrics: metricParts.join(' • '),
    progressPercent,
  };
}

export function getModelProgressShortSummary(
  state?: ModelDownloadState
): string | null {
  const view = getModelProgressView(state);
  if (!view) return null;
  if (view.phase === 'checking') return 'Checking speech model files.';
  if (view.phase === 'loading') return 'Download complete — loading the speech model into memory.';

  const details: string[] = [];
  if (view.progressPercent !== null) {
    details.push(`${Math.round(view.progressPercent)}%`);
  }
  if (
    state?.eta_seconds !== undefined &&
    Number.isFinite(state.eta_seconds) &&
    state.eta_seconds >= 0
  ) {
    details.push(`about ${formatProgressDuration(state.eta_seconds)} remaining`);
  }
  return details.length > 0
    ? `Downloading speech model — ${details.join(', ')}.`
    : 'Downloading speech model — estimating time remaining.';
}
