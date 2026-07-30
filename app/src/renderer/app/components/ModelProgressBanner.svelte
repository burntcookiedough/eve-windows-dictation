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
  <div
    class="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+7rem)] z-20 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2"
  >
    {#if modelDownload.status === 'error'}
      <section class="rounded-xl border border-red-900/60 bg-zinc-950/95 p-4 shadow-lg">
        <p class="text-sm font-medium text-red-300 text-pretty">Speech model setup failed</p>
        <p class="mt-1 text-xs text-red-300/80 text-pretty">
          {modelDownload.detail ?? 'Check your connection.'} Open Settings &gt; Advanced for details.
          {#if $serverStatusState.state?.managed}
            You can restart the managed server there.
          {:else if $serverStatusState.state}
            Eve cannot restart an external server.
          {:else}
            Management mode cannot be confirmed yet.
          {/if}
        </p>
      </section>
    {:else}
      <ModelProgressCard state={modelDownload} announce={false} />
    {/if}
  </div>
{/if}
