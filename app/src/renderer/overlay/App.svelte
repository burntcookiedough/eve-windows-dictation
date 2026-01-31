<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Pill from './components/Pill.svelte';
  import TextDisplay from './components/TextDisplay.svelte';
  import { audioCapture } from './audio-capture';
  import type { RecordingState, TranscriptionPayload } from '../../shared/types';

  let recordingState = $state<RecordingState>('idle');
  let transcriptionText = $state('');
  let transcriptionType = $state<'partial' | 'final'>('partial');
  let audioLevels = $state<number[]>(new Array(40).fill(0));
  let isVisible = $state(false);

  let cleanupFns: Array<() => void> = [];

  async function startAudioCapture() {
    try {
      await audioCapture.start(
        // On audio data - send to main process
        (buffer) => {
          window.murmur.sendAudioData(buffer);
        },
        // On levels - update waveform
        (levels) => {
          audioLevels = levels;
        }
      );
    } catch (error) {
      console.error('Failed to start audio capture:', error);
    }
  }

  function stopAudioCapture() {
    audioCapture.stop();
    audioLevels = new Array(40).fill(0);
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

    // Subscribe to start/stop commands from main process
    cleanupFns.push(
      window.murmur.onStartRecording(() => {
        startAudioCapture();
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
    cleanupFns.forEach(fn => fn());
    window.murmur.removeAllListeners();
  });
</script>

<div class="overlay-container" class:visible={isVisible}>
  {#if transcriptionText}
    <TextDisplay text={transcriptionText} isFinal={transcriptionType === 'final'} />
  {/if}

  <Pill state={recordingState} levels={audioLevels} />
</div>

<style>
  .overlay-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 150ms ease-out, transform 150ms ease-out;
    pointer-events: none;
  }

  .overlay-container.visible {
    opacity: 1;
    transform: translateY(0);
  }
</style>
