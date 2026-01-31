<script lang="ts">
  import Waveform from './Waveform.svelte';
  import type { RecordingState } from '../../../shared/types';

  interface Props {
    state: RecordingState;
    levels: number[];
  }

  let { state, levels }: Props = $props();

  const stateClasses = $derived({
    idle: '',
    listening: 'listening',
    transcribing: 'transcribing',
    processing: 'processing',
    success: 'success',
    error: 'error',
  }[state] || '');
</script>

<div class="pill {stateClasses}">
  <Waveform {levels} />
</div>

<style>
  .pill {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 300px;
    height: 50px;
    background: rgba(26, 26, 26, 0.95);
    border-radius: 25px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
    transition: background 300ms ease, box-shadow 300ms ease;
  }

  .pill.listening {
    box-shadow: 0 4px 24px rgba(59, 130, 246, 0.2);
  }

  .pill.transcribing {
    box-shadow: 0 4px 24px rgba(59, 130, 246, 0.3);
  }

  .pill.success {
    background: rgba(34, 197, 94, 0.95);
    box-shadow: 0 4px 24px rgba(34, 197, 94, 0.3);
  }

  .pill.error {
    background: rgba(239, 68, 68, 0.95);
    box-shadow: 0 4px 24px rgba(239, 68, 68, 0.3);
  }

  .pill.processing {
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% {
      box-shadow: 0 4px 24px rgba(59, 130, 246, 0.2);
    }
    50% {
      box-shadow: 0 4px 24px rgba(59, 130, 246, 0.5);
    }
  }
</style>
