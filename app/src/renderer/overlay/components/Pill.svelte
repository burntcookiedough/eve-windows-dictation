<script lang="ts">
  import Waveform from './Waveform.svelte';
  import type { RecordingState } from '../../../shared/types';

  interface Props {
    state: RecordingState;
    levels: number[];
  }

  let { state, levels }: Props = $props();

  const isActive = $derived(state === 'listening' || state === 'transcribing');
</script>

<div
  class="flex h-[50px] w-[150px] items-center justify-center overflow-hidden rounded-full border border-white/15 bg-black/90 transition-[border-color,background-color] duration-[120ms] {isActive ? 'border-white/25 bg-black/95' : ''}"
>
  <Waveform {levels} />
</div>
