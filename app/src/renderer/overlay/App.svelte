<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Pill from './components/Pill.svelte';
  import TextDisplay from './components/TextDisplay.svelte';
  import { audioCapture } from './audio-capture';
  import { AUDIO_CONFIG } from '../../shared/constants';
  import type {
    RecordingState,
    RecordingWarningPayload,
    TranscriptionPayload,
  } from '../../shared/types';

  let recordingState = $state<RecordingState>('idle');
  let transcriptionText = $state('');
  let transcriptionType = $state<'partial' | 'final'>('partial');
  let audioLevels = $state<number[]>(new Array(AUDIO_CONFIG.WAVEFORM_BARS).fill(0));
  let isVisible = $state(false);
  let warningMessage = $state('');
  let warningTimeout: ReturnType<typeof setTimeout> | null = null;

  let cleanupFns: Array<() => void> = [];

  async function startAudioCapture(deviceId?: string) {
    try {
      await audioCapture.start(
        // On audio data - send to main process
        (buffer) => {
          window.murmur.sendAudioData(buffer);
        },
        // On levels - update waveform
        (levels) => {
          audioLevels = levels;
        },
        // Options with device ID
        { deviceId }
      );
    } catch (error) {
      console.error('Failed to start audio capture:', error);
    }
  }

  function stopAudioCapture() {
    audioCapture.stop();
    audioLevels = new Array(AUDIO_CONFIG.WAVEFORM_BARS).fill(0);
  }

  onMount(() => {
    // Subscribe to recording state
    cleanupFns.push(
      window.murmur.onRecordingState((payload) => {
        recordingState = payload.state;
        isVisible = payload.isRecording || recordingState === 'success' || recordingState === 'error';

        // Reset text when starting new session
        if (recordingState === 'listening') {
          transcriptionText = '';
          transcriptionType = 'partial';
        }
      })
    );

    // Subscribe to transcription updates
    cleanupFns.push(
      window.murmur.onTranscription((payload: TranscriptionPayload) => {
        transcriptionText = payload.text;
        transcriptionType = payload.type;
      })
    );

    cleanupFns.push(
      window.murmur.onWarning((payload: RecordingWarningPayload) => {
        warningMessage = payload.message;

        if (warningTimeout) {
          clearTimeout(warningTimeout);
        }
        warningTimeout = setTimeout(() => {
          warningMessage = '';
          warningTimeout = null;
        }, 5000);
      })
    );

    // Subscribe to start/stop commands from main process
    cleanupFns.push(
      window.murmur.onStartRecording((deviceId) => {
        startAudioCapture(deviceId);
      })
    );

    cleanupFns.push(
      window.murmur.onStopRecording(() => {
        stopAudioCapture();
      })
    );
  });

  onDestroy(() => {
    stopAudioCapture();
    if (warningTimeout) {
      clearTimeout(warningTimeout);
    }
    cleanupFns.forEach(fn => fn());
    window.murmur.removeAllListeners();
  });
</script>

<div
  class="flex flex-col items-center gap-8 pointer-events-none transition-all duration-150 ease-out {isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}"
>
  {#if warningMessage}
    <div class="max-w-xl rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <p class="text-center text-xs font-medium text-amber-200">
        {warningMessage}
      </p>
    </div>
  {/if}

  {#if transcriptionText}
    <TextDisplay text={transcriptionText} isFinal={transcriptionType === 'final'} />
  {/if}

  <Pill state={recordingState} levels={audioLevels} />
</div>
