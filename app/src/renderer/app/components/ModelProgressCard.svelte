<script lang="ts">
  import type { ModelDownloadState } from '$shared/types';
  import { getModelProgressView } from '$shared/model-progress';

  let { state, announce = false }: { state?: ModelDownloadState; announce?: boolean } = $props();
  let view = $derived(getModelProgressView(state));
</script>

{#if view}
  <section
    aria-live={announce ? 'polite' : undefined}
    aria-atomic={announce ? 'true' : undefined}
    class="model-progress-inline min-w-0 py-2"
  >
    <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div class="min-w-0">
        <p class="text-xs font-medium text-zinc-200 text-pretty">{view.title}</p>
        <p class="mt-1 text-xs text-zinc-500 text-pretty [overflow-wrap:anywhere]">{view.summary}</p>
      </div>
      <span class="w-fit shrink-0 text-[11px] text-zinc-500 tabular-nums">
        {view.stepLabel}
      </span>
    </div>

    {#if view.progressPercent !== null}
      <progress
        class="mt-2 h-0.5 w-full overflow-hidden rounded-full accent-zinc-400"
        max="100"
        value={view.progressPercent}
        aria-label={`${view.title}: ${Math.round(view.progressPercent)}%`}
      ></progress>
    {:else if view.phase === 'downloading'}
      <progress
        class="mt-2 h-0.5 w-full overflow-hidden rounded-full accent-zinc-400"
        max="100"
        aria-label={`${view.title}: progress unavailable; transfer is continuing`}
      ></progress>
    {/if}

    {#if view.metrics}
      <p class="mt-2 text-xs text-zinc-400 text-pretty tabular-nums [overflow-wrap:anywhere]">{view.metrics}</p>
    {/if}
  </section>
{/if}

<style>
  .model-progress-inline p,
  .model-progress-inline span {
    color: var(--fg2, #9b9b9b);
  }

  .model-progress-inline .font-medium {
    color: var(--fg, #ececec);
  }

  progress {
    display: block;
    border: 0;
    background: var(--line2, #27272a);
  }

  progress::-webkit-progress-bar {
    background: var(--line2, #27272a);
  }

  progress::-webkit-progress-value {
    background: var(--fg2, #9b9b9b);
  }

  progress::-moz-progress-bar {
    background: var(--fg2, #9b9b9b);
  }
</style>
