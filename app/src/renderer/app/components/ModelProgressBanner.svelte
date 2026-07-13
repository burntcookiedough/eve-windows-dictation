<script lang="ts">
  import { onMount } from 'svelte';
  import type { ServerStatePayload } from '$shared/types';
  import { shouldShowModelProgress } from '$shared/model-progress';
  import ModelProgressCard from './ModelProgressCard.svelte';

  let { visible = true }: { visible?: boolean } = $props();
  let serverState = $state<ServerStatePayload | null>(null);
  let modelDownload = $derived(serverState?.modelDownload);
  let showBanner = $derived(
    modelDownload?.status === 'error' || shouldShowModelProgress(modelDownload)
  );

  async function refreshServerState() {
    try {
      serverState = await window.murmurMain.getServerStatus();
    } catch {
      // The managed server can be unavailable briefly while the app starts.
    }
  }

  onMount(() => {
    void refreshServerState();
    const timer = window.setInterval(refreshServerState, 3000);
    return () => window.clearInterval(timer);
  });
</script>

{#if visible && modelDownload && showBanner}
  <div
    class="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+7rem)] z-20 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2"
  >
    {#if modelDownload.status === 'error'}
      <section aria-live="assertive" class="rounded-xl border border-red-900/60 bg-zinc-950/95 p-4 shadow-lg">
        <p class="text-sm font-medium text-red-300 text-pretty">Speech model setup failed</p>
        <p class="mt-1 text-xs text-red-300/80 text-pretty">
          {modelDownload.detail ?? 'Check your connection.'} Open Server and use Restart to retry.
        </p>
      </section>
    {:else}
      <ModelProgressCard state={modelDownload} />
    {/if}
  </div>
{/if}
