<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import Pill from './components/Pill.svelte';
  import { audioCapture } from './audio-capture';
  import { OverlayPerfObserver } from './perf-observation';
  import { condenseWarning, derivePillView, holdVoice, INTRO_HOLD_MS } from './pill-view';
  import { AUDIO_CONFIG } from '../../shared/constants';
  import { countWords } from '../../shared/insights';
  import type {
    RecordingState,
    RecordingStatusPayload,
    RecordingWarningPayload,
    TranscriptionPayload,
    DictationSessionMode,
  } from '../../shared/types';

  let recordingState = $state<RecordingState>('idle');
  let sessionMode = $state<DictationSessionMode>('quick');
  let audioLevels = $state<number[]>(new Array(AUDIO_CONFIG.WAVEFORM_BARS).fill(0));
  let isVisible = $state(false);
  let warningMessage = $state('');
  let warningTimeout: ReturnType<typeof setTimeout> | null = null;
  let isLongSession = $state(false);
  let chunk = $state<{ index: number; total: number } | null>(null);
  let wordCount = $state<number | null>(null);
  let hasListened = $state(false);
  let isSpeaking = $state(false);
  let elapsedMs = $state(0);
  let listenStartedAt = 0;
  let voiceOpenUntil = 0;
  let clockInterval: ReturnType<typeof setInterval> | null = null;

  let cleanupFns: Array<() => void> = [];
  let perfObserver: OverlayPerfObserver | null = null;
  let captureSessionId: number | undefined;

  const pillView = $derived(derivePillView({
    state: recordingState,
    hasListened,
    isSpeaking,
    elapsedMs,
    isLongSession,
    chunk,
    wordCount,
    alert: warningMessage,
  }));

  function clearWarning() {
    if (warningTimeout) {
      clearTimeout(warningTimeout);
      warningTimeout = null;
    }
    warningMessage = '';
  }

  function beginSession() {
    clearWarning();
    isLongSession = sessionMode === 'long';
    chunk = null;
    wordCount = null;
    hasListened = false;
    elapsedMs = 0;
  }

  function tickClock() {
    const now = performance.now();
    elapsedMs = now - listenStartedAt;
    isSpeaking = now < voiceOpenUntil;
  }

  function startClock() {
    if (!hasListened) {
      hasListened = true;
      listenStartedAt = performance.now();
      voiceOpenUntil = listenStartedAt + INTRO_HOLD_MS;
    }
    if (clockInterval) return;
    tickClock();
    clockInterval = setInterval(tickClock, 200);
  }

  function stopClock() {
    if (clockInterval) {
      clearInterval(clockInterval);
      clockInterval = null;
    }
    isSpeaking = false;
  }

  function reportPerf(observer: OverlayPerfObserver | null) {
    if (!observer) return;
    try { window.murmur.reportPerfObservation?.(observer.snapshot()); } catch { /* diagnostic only */ }
  }

  async function startAudioCapture(deviceId?: string, sessionId?: number) {
    const observer = perfObserver;
    try {
      await audioCapture.start(
        // On audio data - send to main process
        (buffer) => {
          observer?.mark('lastAudioAt');
          window.murmur.sendAudioData(buffer, sessionId);
        },
        // On levels - drive the pill
        (levels) => {
          audioLevels = levels;
          const now = performance.now();
          voiceOpenUntil = holdVoice(levels[levels.length - 1] ?? 0, now, voiceOpenUntil);
          isSpeaking = now < voiceOpenUntil;
        },
        // Options with device ID
        { deviceId, ...(observer ? { onCaptureReady: (timestamp: number) => {
          observer.mark('captureReadyAt', timestamp);
          reportPerf(observer);
        } } : {}) }
      );
    } catch (error) {
      console.error('Failed to start audio capture:', error);
      const code = error instanceof DOMException ? error.name : 'AudioCaptureError';
      const message =
        code === 'NotAllowedError'
          ? 'Microphone access was denied. Allow microphone access in Windows settings and try again.'
          : code === 'NotFoundError' || code === 'OverconstrainedError'
            ? 'The selected microphone is unavailable. Reconnect it or choose another input device.'
            : error instanceof Error
              ? `Could not start the microphone: ${error.message}`
              : 'Could not start the microphone. Check the selected input device and try again.';

      if (captureSessionId === sessionId) {
        window.murmur.reportAudioCaptureError({ code, message, deviceId, sessionId });
      }
    }
  }

  function stopAudioCapture() {
    perfObserver?.mark('stopRequestedAt');
    audioCapture.stop();
    reportPerf(perfObserver);
    audioLevels = new Array(AUDIO_CONFIG.WAVEFORM_BARS).fill(0);
  }

  onMount(() => {
    // Subscribe to recording state
    cleanupFns.push(
      window.murmur.onRecordingState((payload) => {
        const previousState = recordingState;
        recordingState = payload.state;
        sessionMode = payload.mode ?? sessionMode;
        isVisible = payload.isRecording || recordingState === 'success' || recordingState === 'error';

        // Main opens every session with idle then 'processing', before the server is ready
        if (recordingState === 'processing' && previousState === 'idle') {
          beginSession();
        }

        if (recordingState === 'listening' || recordingState === 'transcribing') {
          startClock();
        } else {
          stopClock();
        }
      })
    );

    // The pill never shows transcript text; only the final word count is kept
    cleanupFns.push(
      window.murmur.onTranscription((payload: TranscriptionPayload) => {
        const observer = payload.perfTraceId === perfObserver?.snapshot().traceId ? perfObserver : null;
        if (payload.type === 'partial') {
          if (observer?.snapshot().firstPartialReceivedAt === null) {
            observer.mark('firstPartialReceivedAt');
            reportPerf(observer);
          }
        } else {
          observer?.mark('finalReceivedAt');
        }
        if (payload.type === 'final') {
          wordCount = countWords(payload.text);
          if (observer) {
            void tick().then(() => {
              observer.mark('finalDomCommittedAt');
              reportPerf(observer);
            });
          }
        }
      })
    );

    cleanupFns.push(
      window.murmur.onWarning((payload: RecordingWarningPayload) => {
        warningMessage = condenseWarning(payload.code, payload.message);

        if (warningTimeout) {
          clearTimeout(warningTimeout);
        }
        warningTimeout = setTimeout(() => {
          warningMessage = '';
          warningTimeout = null;
        }, 5000);
      })
    );

    cleanupFns.push(
      window.murmur.onStatus((payload: RecordingStatusPayload) => {
        if (payload.status === 'long_dictation_started') {
          isLongSession = true;
        } else if (payload.status === 'long_dictation_processing') {
          chunk = payload.chunkIndex && payload.chunkTotal
            ? { index: payload.chunkIndex, total: payload.chunkTotal }
            : null;
        }
      })
    );

    // Subscribe to start/stop commands from main process
    cleanupFns.push(
      window.murmur.onStartRecording((deviceId, traceId, sessionId) => {
        captureSessionId = sessionId;
        perfObserver = traceId && /^[a-zA-Z0-9_.-]{1,64}$/.test(traceId) ? new OverlayPerfObserver(traceId) : null;
        startAudioCapture(deviceId, sessionId);
      })
    );

    cleanupFns.push(
      window.murmur.onStopRecording((sessionId, drain) => {
        if (sessionId === undefined) {
          captureSessionId = undefined;
          stopAudioCapture();
        } else if (sessionId === captureSessionId) {
          if (!drain) {
            captureSessionId = undefined;
            stopAudioCapture();
            return;
          }
          perfObserver?.mark('stopRequestedAt');
          void audioCapture.drain().then(drained => {
            if (captureSessionId === sessionId) {
              captureSessionId = undefined;
              reportPerf(perfObserver);
              audioLevels = new Array(AUDIO_CONFIG.WAVEFORM_BARS).fill(0);
            }
            window.murmur.reportCaptureStopped(sessionId, drained);
          });
        }
      })
    );
  });

  onDestroy(() => {
    stopAudioCapture();
    stopClock();
    clearWarning();
    cleanupFns.forEach(fn => fn());
    window.murmur.removeAllListeners();
  });
</script>

<div
  class="flex h-screen w-screen items-center justify-center pointer-events-none transition-all duration-[180ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] {isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}"
  aria-hidden="true"
>
  <Pill view={pillView} levels={audioLevels} />
</div>
