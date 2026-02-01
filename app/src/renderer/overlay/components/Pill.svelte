<script lang="ts">
  import Waveform from './Waveform.svelte';
  import type { RecordingState } from '../../../shared/types';

  interface Props {
    state: RecordingState;
    levels: number[];
  }

  let { state, levels }: Props = $props();

  const isError = $derived(state === 'error');
</script>

<div class="pill" class:error={isError}>
  <Waveform {levels} color={isError ? 'linear-gradient(to top, #ef4444, #f87171)' : undefined} />
</div>

<style>
  .pill {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 150px;
    height: 50px;
    background: rgb(0, 0, 0);
    border-radius: 25px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    box-shadow: 0 4px 16px rgba(255, 255, 255, 0.08);
    transition: box-shadow 200ms ease;
    overflow: hidden;
  }

  .pill.error {
    box-shadow: 0 4px 16px rgba(239, 68, 68, 0.3);
  }
</style>
