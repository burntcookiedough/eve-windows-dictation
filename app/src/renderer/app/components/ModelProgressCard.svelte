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
    class="min-w-0 rounded-lg border border-amber-500/25 bg-amber-950/20 p-3"
  >
    <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div class="min-w-0">
        <p class="text-sm font-medium text-amber-100 text-pretty">{view.title}</p>
        <p class="mt-1 text-xs text-amber-200/80 text-pretty [overflow-wrap:anywhere]">{view.summary}</p>
      </div>
      <span class="w-fit shrink-0 rounded-full bg-amber-950/70 px-2 py-1 text-xs text-amber-200/80 tabular-nums">
        {view.stepLabel}
      </span>
    </div>

    {#if view.progressPercent !== null}
      <progress
        class="mt-3 h-1.5 w-full overflow-hidden rounded-full accent-amber-400"
        max="100"
        value={view.progressPercent}
        aria-label={`${view.title}: ${Math.round(view.progressPercent)}%`}
      ></progress>
    {:else if view.phase === 'downloading'}
      <progress
        class="mt-3 h-1.5 w-full overflow-hidden rounded-full accent-amber-400"
        max="100"
        aria-label={`${view.title}: progress unavailable`}
        aria-valuetext="Download progress is unavailable; transfer is continuing."
      ></progress>
    {/if}

    {#if view.metrics}
      <p class="mt-2 text-xs text-zinc-400 text-pretty tabular-nums [overflow-wrap:anywhere]">{view.metrics}</p>
    {/if}
  </section>
{/if}
