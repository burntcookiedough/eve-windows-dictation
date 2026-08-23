import { writable } from 'svelte/store';
import { shouldShowModelProgress } from '$shared/model-progress';
import type { ServerStatePayload } from '$shared/types';

export type ServerStatusPhase =
  | 'connecting'
  | 'stale'
  | 'unavailable'
  | 'missing'
  | 'partial'
  | 'checking'
  | 'downloading'
  | 'loading'
  | 'ready'
  | 'error';

export interface SharedServerStatus {
  state: ServerStatePayload | null;
  phase: ServerStatusPhase;
  announcement: string;
}

const initialStatus: SharedServerStatus = {
  state: null,
  phase: 'connecting',
  announcement: 'Checking Eve speech readiness.',
};

export const serverStatusState = writable<SharedServerStatus>(initialStatus);

export function getServerStatusPhase(state: ServerStatePayload | null): ServerStatusPhase {
  if (!state) return 'unavailable';
  if (state.status === 'error' || state.engineStatus?.status === 'error' || state.modelDownload?.status === 'error') {
    return 'error';
  }
  if (state.status === 'starting' || state.status === 'stopping') return 'connecting';

  const model = state.modelDownload;
  if (model?.phase === 'checking') return 'checking';
  if (model?.phase === 'downloading' || model?.status === 'downloading') return 'downloading';
  if (model?.phase === 'loading' || state.engineStatus?.status === 'loading') return 'loading';
  if (model?.status === 'missing') return 'missing';
  if (model?.status === 'partial') return 'partial';
  if (state.status === 'running' && state.engineStatus?.status === 'ready') return 'ready';
  if (state.status === 'idle') return 'stale';
  return 'unavailable';
}

function phaseAnnouncement(phase: ServerStatusPhase, state: ServerStatePayload | null): string {
  const model = state?.modelDownload?.model;
  switch (phase) {
    case 'connecting': return 'Connecting to Eve speech services.';
    case 'stale': return 'Speech readiness is being refreshed.';
    case 'unavailable': return 'Speech service is unavailable.';
    case 'missing': return model ? `${model} is not prepared.` : 'A speech model is not prepared.';
    case 'partial': return model ? `${model} has a partial download.` : 'A speech model has a partial download.';
    case 'checking': return 'Checking speech model files.';
    case 'downloading': return 'Downloading the speech model.';
    case 'loading': return 'Loading the speech model.';
    case 'ready': return 'Speech model is ready.';
    case 'error': return 'Speech model setup needs attention.';
  }
}

export function getDownloadMilestone(percent?: number): number | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 25) return null;
  return Math.min(100, Math.floor(percent / 25) * 25);
}

function milestone(state: ServerStatePayload | null): number | null {
  return getDownloadMilestone(state?.modelDownload?.progress_percent);
}

let current = initialStatus;
let unsubscribe: (() => void) | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;
let retryInFlight = false;
let initialized = false;
let announcedMilestone: number | null = null;
let lifecycleGeneration = 0;
let eventRevision = 0;
let pollRequestGeneration = 0;
let retryRequestGeneration = 0;

function reseedOnFocus(): void {
  void refresh();
}

function publish(state: ServerStatePayload | null): void {
  const phase = getServerStatusPhase(state);
  const nextMilestone = milestone(state);
  const phaseChanged = phase !== current.phase;
  const milestoneChanged = phase === 'downloading' && nextMilestone !== null && nextMilestone !== announcedMilestone;
  const announcement = phaseChanged || milestoneChanged
    ? (milestoneChanged ? `Speech model download ${nextMilestone}% complete.` : phaseAnnouncement(phase, state))
    : current.announcement;

  announcedMilestone = nextMilestone;
  current = { ...current, state, phase, announcement };
  serverStatusState.set(current);
  schedulePoll();
}

function clearPoll(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll(): void {
  clearPoll();
  if (!current.state || !shouldShowModelProgress(current.state.modelDownload) || !initialized) return;
  pollTimer = setTimeout(() => void refresh(), 3000);
}

export async function refresh(): Promise<void> {
  if (!initialized || pollInFlight) return;
  pollInFlight = true;
  const requestLifecycle = lifecycleGeneration;
  const requestEventRevision = eventRevision;
  const requestGeneration = ++pollRequestGeneration;
  try {
    const state = await window.murmurMain.getServerStatus();
    if (requestLifecycle === lifecycleGeneration && requestEventRevision === eventRevision) publish(state);
  } catch {
    // A failed reseed must clear the old state rather than continuing to show Ready.
    if (requestLifecycle === lifecycleGeneration && requestEventRevision === eventRevision) publish(null);
  } finally {
    if (requestLifecycle === lifecycleGeneration && requestGeneration === pollRequestGeneration) pollInFlight = false;
  }
}

export function initializeServerStatus(): void {
  if (initialized) return;
  lifecycleGeneration += 1;
  eventRevision += 1;
  initialized = true;
  current = initialStatus;
  announcedMilestone = null;
  serverStatusState.set(current);
  unsubscribe = window.murmurMain.onServerStateChange((state) => {
    eventRevision += 1;
    publish(state);
  });
  window.addEventListener('focus', reseedOnFocus);
  void refresh();
}

export function disposeServerStatus(): void {
  lifecycleGeneration += 1;
  eventRevision += 1;
  initialized = false;
  clearPoll();
  unsubscribe?.();
  unsubscribe = null;
  window.removeEventListener('focus', reseedOnFocus);
  pollInFlight = false;
  retryInFlight = false;
}

export async function retryManagedServer(): Promise<boolean> {
  if (!initialized || !current.state?.managed || retryInFlight) return false;
  retryInFlight = true;
  const requestLifecycle = lifecycleGeneration;
  const requestEventRevision = eventRevision;
  const requestGeneration = ++retryRequestGeneration;
  try {
    const state = await window.murmurMain.restartServer();
    if (requestLifecycle !== lifecycleGeneration || requestEventRevision !== eventRevision) return false;
    publish(state);
    return true;
  } catch {
    if (requestLifecycle === lifecycleGeneration && requestEventRevision === eventRevision) publish(null);
    return false;
  } finally {
    if (requestLifecycle === lifecycleGeneration && requestGeneration === retryRequestGeneration) retryInFlight = false;
  }
}
