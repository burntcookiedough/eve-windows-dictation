<script lang="ts">
  import { onMount } from 'svelte';
  import type { ServerStatusPhase } from '../server-status';
  import Cactus from './Cactus.svelte';

  interface Props {
    phase: ServerStatusPhase;
    modelName?: string;
    progressPercent?: number;
    onComplete: () => void;
  }

  let { phase, modelName, progressPercent, onComplete }: Props = $props();
  let running = $state(false);
  let flying = $state(false);
  let flightTransform = $state('');
  let plant: HTMLDivElement | null = null;

  const letters = ['E', 'V', 'E'];

  let statusText = $derived.by(() => {
    switch (phase) {
      case 'connecting': return 'connecting';
      case 'stale': return 'refreshing readiness';
      case 'unavailable': return 'speech service unavailable';
      case 'missing': return modelName ? `${modelName} not prepared` : 'speech model not prepared';
      case 'partial': return modelName ? `${modelName} needs more files` : 'speech model needs more files';
      case 'checking': return 'checking speech model files';
      case 'downloading':
        return typeof progressPercent === 'number' && Number.isFinite(progressPercent)
          ? `downloading · ${Math.round(progressPercent)}%`
          : 'downloading speech model';
      case 'loading': return 'loading speech model';
      case 'ready': return 'ready';
      case 'error': return 'speech setup needs attention';
    }
  });

  onMount(() => {
    let active = true;
    let finishTimer: ReturnType<typeof setTimeout> | null = null;
    const runFrame = requestAnimationFrame(() => { running = true; });
    const flightTimer = window.setTimeout(() => {
      if (!active || !plant) return;
      const source = plant.querySelector('svg');
      const target = document.querySelector<SVGSVGElement>('[data-home-cactus="true"]');
      if (source && target) {
        const from = source.getBoundingClientRect();
        const to = target.getBoundingClientRect();
        const scale = from.height > 0 ? to.height / from.height : 1;
        const dx = to.left + to.width / 2 - (from.left + from.width / 2);
        const dy = to.top + to.height / 2 - (from.top + from.height / 2);
        flightTransform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      }
      flying = true;
      finishTimer = window.setTimeout(() => {
        if (active) onComplete();
      }, 1000);
    }, 2300);

    return () => {
      active = false;
      cancelAnimationFrame(runFrame);
      window.clearTimeout(flightTimer);
      if (finishTimer !== null) window.clearTimeout(finishTimer);
    };
  });
</script>

<div class="app-launch-intro" class:app-launch-intro--run={running} class:app-launch-intro--fly={flying} aria-label="Starting Eve">
  <div class="app-launch-intro__plant" bind:this={plant} style:transform={flightTransform}>
    <Cactus class="app-launch-intro__cactus" draw />
  </div>
  <div class="app-launch-intro__wordmark" aria-label="Eve">
    {#each letters as letter, index (index)}
      <span style={`transition-delay:${.95 + index * .1}s`}>{letter}</span>
    {/each}
  </div>
  <div class="app-launch-intro__status mono" aria-live="polite">{statusText}</div>
  <div class="app-launch-intro__progress" aria-hidden="true"><span></span></div>
</div>
