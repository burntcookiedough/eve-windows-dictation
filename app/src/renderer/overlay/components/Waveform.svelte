<script lang="ts">
  interface Props {
    levels: number[];
  }

  let { levels }: Props = $props();

  // Normalize levels to 0-1 range and apply some smoothing
  const normalizedLevels = $derived(
    levels.map(level => Math.min(1, Math.max(0, level * 3)))
  );
</script>

<div class="waveform">
  {#each normalizedLevels as level, i}
    <div
      class="bar"
      style="--height: {Math.max(0.1, level)}"
    ></div>
  {/each}
</div>

<style>
  .waveform {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: 30px;
    padding: 0 16px;
  }

  .bar {
    width: 4px;
    border-radius: 2px;
    background: linear-gradient(to top, #3b82f6, #60a5fa);
    transition: height 50ms ease-out;

    /* Mirrored bars effect using scaleY */
    height: calc(var(--height) * 30px);
    min-height: 3px;
  }

  /* Add subtle animation when not receiving audio */
  .bar:nth-child(odd) {
    animation: subtle-pulse 2s ease-in-out infinite;
    animation-delay: calc(var(--height) * 0.1s);
  }

  @keyframes subtle-pulse {
    0%, 100% {
      opacity: 0.8;
    }
    50% {
      opacity: 1;
    }
  }
</style>
