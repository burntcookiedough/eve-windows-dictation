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

<div
  class="flex items-center justify-center w-[150px] h-[50px] bg-black rounded-full border border-zinc-500/25 overflow-hidden transition-shadow duration-200 {isError ? 'shadow-[0_4px_16px_rgba(239,68,68,0.3)]' : 'shadow-[0_4px_16px_rgba(255,255,255,0.08)]'}"
>
  <Waveform {levels} color={isError ? 'linear-gradient(to top, #ef4444, #f87171)' : undefined} />
</div>
