import { afterEach, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import type { RecordingStatePayload } from '../src/shared/types';
import {
  initializeRecordingRendererState,
  recordingRendererState,
} from '../src/renderer/app/recording-renderer-state';

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
});

test('ignores queued recording callbacks from a disposed renderer lifecycle', () => {
  const recordingCallbacks: Array<(recording: RecordingStatePayload) => void> = [];
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: unknown }).window = {
    murmurMain: {
      onRecordingState: (callback: (recording: RecordingStatePayload) => void) => {
        recordingCallbacks.push(callback);
        return () => {};
      },
      onAudioLevel: () => () => {},
      getRecordingDebugState: async () => ({
        recording: { state: 'idle', isRecording: false } satisfies RecordingStatePayload,
      }),
    },
  };

  try {
    dispose = initializeRecordingRendererState();
    const queuedOldLifecycleCallback = recordingCallbacks[0];
    dispose();
    dispose = initializeRecordingRendererState();

    recordingCallbacks[1]({ state: 'listening', isRecording: true, mode: 'long' });
    queuedOldLifecycleCallback({ state: 'error', isRecording: false, mode: 'quick' });

    expect(get(recordingRendererState)).toMatchObject({
      recording: { state: 'listening', mode: 'long' },
      cactusState: 'listening',
    });
  } finally {
    dispose?.();
    dispose = null;
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window: unknown }).window = previousWindow;
  }
});
