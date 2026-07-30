<script lang="ts">
  import { onMount } from 'svelte';
  import ModelProgressCard from '../components/ModelProgressCard.svelte';
  import { shouldShowModelProgress } from '$shared/model-progress';
  import type { ServerStatusPhase } from '../server-status';
  import { retryManagedServer, serverStatusState } from '../server-status';

  interface Props {
    onNavigate: (view: 'history' | 'insights' | 'settings') => void;
  }

  let { onNavigate }: Props = $props();
  let quickHotkey = $state('Checking shortcut…');
  let longHotkey = $state('Checking shortcut…');
  let shortcutsError = $state(false);
  let useExternalServer = $state<boolean | null>(null);
  let snapshot = $derived($serverStatusState);
  let server = $derived(snapshot.state);
  let engine = $derived(server?.engineStatus?.info);
  let model = $derived(server?.modelDownload ?? null);
  let showModelProgress = $derived(shouldShowModelProgress(model ?? undefined));

  const phaseCopy: Record<ServerStatusPhase, { title: string; detail: string }> = {
    connecting: { title: 'Connecting', detail: 'Checking the local speech service.' },
    stale: { title: 'Refreshing readiness', detail: 'Waiting for a current speech-service status.' },
    unavailable: { title: 'Speech service unavailable', detail: 'Eve cannot currently confirm speech readiness.' },
    missing: { title: 'Speech model not prepared', detail: 'Open Settings to prepare the selected model.' },
    partial: { title: 'Speech model needs completion', detail: 'Open Settings to continue preparing the selected model.' },
    checking: { title: 'Checking model files', detail: 'Looking for the selected speech model.' },
    downloading: { title: 'Preparing speech model', detail: 'The selected model is downloading in the background.' },
    loading: { title: 'Loading speech model', detail: 'The selected model is being loaded into memory.' },
    ready: { title: 'Ready for dictation', detail: 'Eve can accept Quick and Long dictation.' },
    error: { title: 'Speech setup needs attention', detail: 'Open Settings for the current speech-service details.' },
  };

  let readiness = $derived(phaseCopy[snapshot.phase]);
  let externalMode = $derived(useExternalServer === true || (server !== null && !server.managed));
  let managementModeUnknown = $derived(server === null && useExternalServer === null);

  onMount(async () => {
    try {
      const settings = await window.murmurMain.getSettings();
      useExternalServer = settings.useExternalServer;
      [quickHotkey, longHotkey] = await Promise.all([
        window.murmurMain.getHotkeyDisplayName(settings.hotkey),
        window.murmurMain.getHotkeyDisplayName(settings.longHotkey),
      ]);
    } catch {
      shortcutsError = true;
      quickHotkey = 'Shortcut unavailable';
      longHotkey = 'Shortcut unavailable';
    }
  });

  function retry(): void {
    void retryManagedServer();
  }
</script>

<div class="h-full overflow-y-auto p-4 sm:p-6">
  <div class="mx-auto flex max-w-4xl flex-col gap-5">
    <section class="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6" aria-labelledby="home-readiness-heading">
      <p class="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">Eve</p>
      <div class="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 id="home-readiness-heading" class="text-2xl font-semibold text-zinc-50">{readiness.title}</h1>
          <p class="mt-1 max-w-xl text-sm text-zinc-400">{readiness.detail}</p>
        </div>
        {#if externalMode}
          <p class="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-400">
            External server — Eve cannot restart this endpoint.
          </p>
        {:else if server?.managed && (snapshot.phase === 'error' || snapshot.phase === 'unavailable')}
          <button
            type="button"
            onclick={retry}
            disabled={!server?.managed}
            class="rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]
              {server?.managed ? 'bg-zinc-100 text-zinc-950 hover:bg-white cursor-pointer' : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
          >
            Retry managed server
          </button>
        {:else if managementModeUnknown && (snapshot.phase === 'error' || snapshot.phase === 'unavailable')}
          <p class="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-400">
            Management mode cannot be confirmed. Open Settings &gt; Advanced.
          </p>
        {/if}
      </div>

      <dl class="mt-5 grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl border border-white/10 bg-black/20 p-3">
          <dt class="text-xs font-medium uppercase tracking-[0.12em] text-zinc-500">Current engine</dt>
          <dd class="mt-1 text-sm text-zinc-100">{engine?.name ?? server?.engineStatus?.current ?? 'Checking current engine…'}</dd>
        </div>
        <div class="rounded-xl border border-white/10 bg-black/20 p-3">
          <dt class="text-xs font-medium uppercase tracking-[0.12em] text-zinc-500">Selected model</dt>
          <dd class="mt-1 text-sm text-zinc-100">{model?.model ?? engine?.model ?? 'Checking selected model…'}</dd>
        </div>
      </dl>

      {#if engine}
        <p class="mt-4 text-xs leading-5 text-zinc-400">
          {engine.languages.length > 0 ? `Languages: ${engine.languages.join(', ')}.` : 'Language coverage is not reported by the current engine.'}
          {#if engine.model_size_gb > 0} Approx. {engine.model_size_gb.toFixed(1)} GB.{/if}
          {#if engine.device} Running on {engine.device}.{/if}
        </p>
      {/if}

      {#if model && snapshot.phase === 'downloading'}
        <p class="mt-4 text-sm text-zinc-300">
          {#if typeof model.downloaded_bytes === 'number' && typeof model.total_bytes === 'number' && model.total_bytes > 0}
            Download progress is available in the preparation banner.
          {:else}
            Downloading with progress details still being established.
          {/if}
        </p>
      {/if}

      {#if showModelProgress}
        <div class="mt-4 max-w-2xl">
          <ModelProgressCard state={model ?? undefined} announce={false} />
        </div>
      {/if}
    </section>

    <section class="grid gap-4 lg:grid-cols-2" aria-label="Dictation shortcuts and guidance">
      <article class="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 class="text-base font-semibold text-zinc-100">Quick dictation</h2>
        <p class="mt-1 text-sm text-zinc-400">Use for short, immediate speech-to-text input.</p>
        <p class="mt-4 font-mono text-sm text-zinc-200">{quickHotkey}</p>
      </article>
      <article class="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 class="text-base font-semibold text-zinc-100">Long dictation</h2>
        <p class="mt-1 text-sm text-zinc-400">Use for longer recordings that Eve processes after capture.</p>
        <p class="mt-4 font-mono text-sm text-zinc-200">{longHotkey}</p>
      </article>
    </section>

    <section class="rounded-2xl border border-white/10 bg-white/[0.03] p-5" aria-labelledby="home-privacy-heading">
      <h2 id="home-privacy-heading" class="text-base font-semibold text-zinc-100">Processing and privacy</h2>
      <p class="mt-1 text-sm leading-6 text-zinc-400">By default, Eve processes speech locally. If you configure an external endpoint, audio is sent to that endpoint under your control. Eve keeps the Murmur legacy profile untouched and does not automatically import personal data.</p>
      {#if shortcutsError}
        <p class="mt-3 text-xs text-zinc-500">Shortcut labels could not be read. Open Settings to review them.</p>
      {/if}
    </section>

    <nav aria-label="Home actions" class="flex flex-wrap gap-2">
      <button type="button" onclick={() => onNavigate('history')} class="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:bg-white/[0.06] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Open History</button>
      <button type="button" onclick={() => onNavigate('insights')} class="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:bg-white/[0.06] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Open Insights</button>
      <button type="button" onclick={() => onNavigate('settings')} class="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:bg-white/[0.06] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Open Settings</button>
    </nav>
  </div>
</div>
