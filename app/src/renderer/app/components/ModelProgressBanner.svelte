<script lang="ts">
  import { shouldShowModelProgress } from '$shared/model-progress';
  import { retryManagedServer, serverStatusState } from '../server-status';

  interface Props {
    visible?: boolean;
    onNavigate?: () => void;
  }

  let { visible = true, onNavigate = () => {} }: Props = $props();
  let retrying = $state(false);
  let snapshot = $derived($serverStatusState);
  let modelDownload = $derived(snapshot.state?.modelDownload);
  let showBanner = $derived(
    snapshot.phase === 'error'
      || snapshot.phase === 'unavailable'
      || snapshot.phase === 'missing'
      || snapshot.phase === 'partial'
      || shouldShowModelProgress(modelDownload)
  );

  let message = $derived.by(() => {
    const model = modelDownload?.model;
    switch (snapshot.phase) {
      case 'connecting': return 'Connecting to speech services';
      case 'stale': return 'Refreshing speech readiness';
      case 'unavailable': return 'Speech service unavailable';
      case 'missing': return model ? `${model} is not prepared` : 'Speech model is not prepared';
      case 'partial': return model ? `${model} needs more files` : 'Speech model needs more files';
      case 'checking': return 'Checking speech model files';
      case 'downloading': return 'Downloading speech model';
      case 'loading': return 'Loading speech model';
      case 'ready': return 'Ready for dictation';
      case 'error': return 'Speech setup needs attention';
    }
  });

  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      await retryManagedServer();
    } finally {
      retrying = false;
    }
  }
</script>

{#if visible && showBanner}
  <section class="app-status-banner" data-status-region="model-progress" aria-label="Speech model status" aria-live="off">
    <span class="app-status-banner__dot" aria-hidden="true"></span>
    <span>{message}</span>
    {#if snapshot.phase === 'downloading' && typeof modelDownload?.progress_percent === 'number' && Number.isFinite(modelDownload.progress_percent)}
      <span class="mono">{Math.round(modelDownload.progress_percent)}%</span>
    {/if}
    <span class="app-status-banner__spacer"></span>
    {#if (snapshot.phase === 'error' || snapshot.phase === 'unavailable') && snapshot.state?.managed}
      <button type="button" onclick={retry} disabled={retrying}>{retrying ? 'retrying' : 'retry'}</button>
    {:else if snapshot.phase === 'error' || snapshot.phase === 'unavailable' || snapshot.phase === 'missing' || snapshot.phase === 'partial'}
      <button type="button" onclick={onNavigate}>settings</button>
    {/if}
  </section>
{/if}
