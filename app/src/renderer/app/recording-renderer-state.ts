import { writable } from 'svelte/store';
import type { RecordingStatePayload } from '$shared/types';

export type CactusMotionState = 'idle' | 'listening' | 'transcribing' | 'done';

export interface RecordingRendererState {
  recording: RecordingStatePayload | null;
  cactusState: CactusMotionState;
  audioLevel: number;
  listeningSince: number | null;
}

const initialState: RecordingRendererState = {
  recording: null,
  cactusState: 'idle',
  audioLevel: 0,
  listeningSince: null,
};

export const recordingRendererState = writable<RecordingRendererState>(initialState);

let currentState = initialState;
let activeDisposer: (() => void) | null = null;
let lifecycle = 0;
let doneTimer: ReturnType<typeof setTimeout> | null = null;

function publish(next: RecordingRendererState): void {
  currentState = next;
  recordingRendererState.set(next);
}

function normalizeLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
}

function cactusStateFor(recording: RecordingStatePayload['state']): CactusMotionState {
  switch (recording) {
    case 'listening': return 'listening';
    case 'processing':
    case 'transcribing': return 'transcribing';
    case 'success': return 'done';
    case 'idle':
    case 'error': return 'idle';
  }
}

function clearDoneTimer(): void {
  if (doneTimer !== null) {
    clearTimeout(doneTimer);
    doneTimer = null;
  }
}

export function initializeRecordingRendererState(): () => void {
  if (activeDisposer) return activeDisposer;

  const currentLifecycle = ++lifecycle;
  let eventRevision = 0;

  function finishDone(): void {
    clearDoneTimer();
    doneTimer = setTimeout(() => {
      doneTimer = null;
      if (currentLifecycle !== lifecycle || currentState.cactusState !== 'done') return;
      publish({ ...currentState, cactusState: 'idle', audioLevel: 0, listeningSince: null });
    }, 720);
  }

  function receiveRecording(recording: RecordingStatePayload): void {
    if (currentLifecycle !== lifecycle) return;
    eventRevision += 1;
    const previousState = currentState.recording?.state;
    const nextCactusState = recording.state === 'idle' && currentState.cactusState === 'done'
      ? 'done'
      : cactusStateFor(recording.state);
    const listeningSince = nextCactusState === 'listening'
      ? previousState === 'listening' ? currentState.listeningSince : Date.now()
      : null;

    publish({
      recording,
      cactusState: nextCactusState,
      audioLevel: nextCactusState === 'listening' ? currentState.audioLevel : 0,
      listeningSince,
    });

    if (nextCactusState === 'done') finishDone();
    else clearDoneTimer();
  }

  const unsubscribeRecording = window.murmurMain.onRecordingState(receiveRecording);
  const unsubscribeAudioLevel = window.murmurMain.onAudioLevel((level) => {
    if (currentLifecycle !== lifecycle || currentState.cactusState !== 'listening') return;
    publish({ ...currentState, audioLevel: normalizeLevel(level) });
  });

  void window.murmurMain.getRecordingDebugState().then((snapshot) => {
    if (currentLifecycle === lifecycle && eventRevision === 0) receiveRecording(snapshot.recording);
  }).catch(() => {
    // Keep the display passive until the first real recording event arrives.
  });

  const dispose = () => {
    if (currentLifecycle !== lifecycle) return;
    lifecycle += 1;
    clearDoneTimer();
    unsubscribeRecording();
    unsubscribeAudioLevel();
    publish(initialState);
    activeDisposer = null;
  };
  activeDisposer = dispose;
  return dispose;
}
