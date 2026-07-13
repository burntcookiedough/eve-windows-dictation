<script lang="ts">
  import type { ModelDownloadState } from '$shared/types';
  import { getModelProgressView } from '$shared/model-progress';

  let { state }: { state?: ModelDownloadState } = $props();
  let view = $derived(getModelProgressView(state));
</script>

{#if view}
  <section
    aria-live="polite"
    aria-atomic="true"
    class="rounded-xl border border-amber-900/60 bg-zinc-950/95 p-4 shadow-lg"
  >
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="text-sm font-medium text-amber-200 text-pretty">{view.title}</p>
        <p class="mt-1 text-xs text-amber-200/75 text-pretty">{view.summary}</p>
      </div>
      <span class="shrink-0 rounded-full bg-amber-950 px-2 py-1 text-xs text-amber-200/80 tabular-nums">
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
    {/if}

    {#if view.metrics}
      <p class="mt-2 text-xs text-zinc-400 text-pretty tabular-nums">{view.metrics}</p>
    {/if}
  </section>
{/if}
