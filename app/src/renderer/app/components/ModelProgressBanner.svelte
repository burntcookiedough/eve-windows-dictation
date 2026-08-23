<script lang="ts">
  import { shouldShowModelProgress } from '$shared/model-progress';
  import ModelProgressCard from './ModelProgressCard.svelte';
  import { serverStatusState } from '../server-status';

  let { visible = true }: { visible?: boolean } = $props();
  let modelDownload = $derived($serverStatusState.state?.modelDownload);
  let showBanner = $derived(
    modelDownload?.status === 'error' || shouldShowModelProgress(modelDownload)
  );
</script>

{#if visible && modelDownload && showBanner}
  <section
    data-status-region="model-progress"
    aria-label="Speech model status"
    class="mx-auto w-full max-w-4xl shrink-0 px-4 pb-3 pt-2 sm:px-6"
  >
    {#if modelDownload.status === 'error'}
      <div class="rounded-lg border border-red-500/30 bg-red-950/25 p-3" role="status" aria-live="off">
        <p class="text-sm font-medium text-red-200 text-pretty">Speech model setup failed</p>
        <p class="mt-1 text-xs text-red-200/80 text-pretty [overflow-wrap:anywhere]">
          {modelDownload.detail ?? 'Check your connection.'} Open Settings &gt; Server &amp; diagnostics for details.
        </p>
      </div>
    {:else}
      <ModelProgressCard state={modelDownload} announce={false} />
    {/if}
  </section>
{/if}
