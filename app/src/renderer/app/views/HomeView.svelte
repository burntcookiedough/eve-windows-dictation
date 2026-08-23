<script lang="ts">
  import { onMount } from 'svelte';
  import type { ServerStatusPhase } from '../server-status';
  import { retryManagedServer, serverStatusState } from '../server-status';
  import PrimaryPage from '../components/PrimaryPage.svelte';

  interface Props {
    onNavigate: (view: 'history' | 'insights' | 'settings') => void;
  }

  let { onNavigate }: Props = $props();
  let quickHotkey = $state('Checking shortcut…');
  let longHotkey = $state('Checking shortcut…');
  let shortcutsError = $state(false);
  let retrying = $state(false);
  let snapshot = $derived($serverStatusState);
  let server = $derived(snapshot.state);
  let engine = $derived(server?.engineStatus?.info);
  let model = $derived(server?.modelDownload ?? null);

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
  let phaseAccent = $derived(
    snapshot.phase === 'ready'
      ? 'emerald'
      : snapshot.phase === 'error' || snapshot.phase === 'unavailable'
        ? 'red'
        : snapshot.phase === 'downloading' || snapshot.phase === 'loading' || snapshot.phase === 'checking'
          ? 'amber'
          : 'zinc'
  );
  let reportedLanguages = $derived(Array.isArray(engine?.languages) ? engine.languages : []);
  let reportedModelSize = $derived(
    typeof engine?.model_size_gb === 'number' && Number.isFinite(engine.model_size_gb) && engine.model_size_gb > 0
      ? engine.model_size_gb
      : null
  );

  onMount(() => {
    async function loadSettings(): Promise<void> {
      try {
        const settings = await window.murmurMain.getSettings();
        [quickHotkey, longHotkey] = await Promise.all([
          window.murmurMain.getHotkeyDisplayName(settings.hotkey),
          window.murmurMain.getHotkeyDisplayName(settings.longHotkey),
        ]);
      } catch {
        shortcutsError = true;
        quickHotkey = 'Shortcut unavailable';
        longHotkey = 'Shortcut unavailable';
      }
    }

    void loadSettings();
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

<PrimaryPage page="home" scrollOwner="home" contentClass="flex flex-col gap-4 pb-5">
    <section
      data-home-hero
      class="relative min-w-0 overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_82%_18%,rgba(255,255,255,0.08),transparent_34%),radial-gradient(circle_at_22%_90%,rgba(161,161,170,0.08),transparent_38%),linear-gradient(145deg,rgba(255,255,255,0.055),rgba(255,255,255,0.018))] px-5 py-6 sm:px-7 sm:py-7"
      aria-labelledby="home-readiness-heading"
    >
      <div aria-hidden="true" class="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full border border-white/10"></div>
      <div aria-hidden="true" class="pointer-events-none absolute -right-8 -top-12 h-40 w-40 rounded-full border border-white/10"></div>

      <div class="relative grid min-w-0 gap-7 md:grid-cols-[minmax(0,1fr)_220px] md:items-center">
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-zinc-300">
              <span class="relative flex h-2 w-2" aria-hidden="true">
                {#if snapshot.phase === 'ready'}<span class="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-emerald-300 opacity-60"></span>{/if}
                <span class="relative inline-flex h-2 w-2 rounded-full {phaseAccent === 'emerald' ? 'bg-emerald-300' : phaseAccent === 'red' ? 'bg-red-300' : phaseAccent === 'amber' ? 'bg-amber-300' : 'bg-zinc-500'}"></span>
              </span>
              {snapshot.phase === 'ready' ? 'Listening when you are' : readiness.title}
            </span>
          </div>

          <p class="mt-6 text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">Your words, ready to move</p>
          <h1 id="home-readiness-heading" class="mt-2 max-w-xl text-3xl font-semibold tracking-[-0.035em] text-zinc-50 sm:text-4xl">
            {readiness.title}
          </h1>
          <p class="mt-3 max-w-xl text-sm leading-6 text-zinc-400">{readiness.detail}</p>

          <dl data-home-engine-summary class="mt-6 flex min-w-0 flex-wrap gap-x-5 gap-y-3 border-t border-white/[0.08] pt-4">
            <div class="min-w-0">
              <dt class="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">Engine</dt>
              <dd class="mt-1 max-w-[220px] truncate text-sm text-zinc-200">{engine?.name ?? server?.engineStatus?.current ?? 'Checking…'}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">Model</dt>
              <dd class="mt-1 max-w-[260px] truncate text-sm text-zinc-200">{model?.model ?? engine?.model ?? 'Checking…'}</dd>
            </div>
            {#if reportedModelSize !== null}
              <div>
                <dt class="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">Size</dt>
                <dd class="mt-1 text-sm text-zinc-200">~{reportedModelSize.toFixed(1)} GB</dd>
              </div>
            {/if}
          </dl>
        </div>

        <div data-home-voice-orb class="relative mx-auto flex h-44 w-44 items-center justify-center md:h-48 md:w-48" aria-hidden="true">
          <div class="absolute inset-0 rounded-full border border-white/10 bg-white/[0.025] shadow-[0_20px_80px_rgba(255,255,255,0.04)]"></div>
          <div class="absolute inset-5 rounded-full border border-white/10 bg-gradient-to-br from-white/10 via-transparent to-zinc-500/10 {snapshot.phase === 'ready' ? 'motion-safe:animate-pulse' : ''}"></div>
          <div class="relative flex h-20 w-24 items-center justify-center gap-1 rounded-full border border-white/10 bg-black/25 shadow-inner">
            {#each ['h-1.5', 'h-2.5', 'h-4', 'h-6', 'h-4', 'h-2.5', 'h-1.5'] as heightClass}
              <span class="w-1 rounded-full {heightClass} {phaseAccent === 'emerald' ? 'bg-emerald-300/80' : phaseAccent === 'red' ? 'bg-red-300/70' : phaseAccent === 'amber' ? 'bg-amber-300/75' : 'bg-zinc-500'} {snapshot.phase === 'ready' ? 'motion-safe:animate-pulse' : ''}"></span>
            {/each}
          </div>
        </div>
      </div>

      {#if server?.managed && (snapshot.phase === 'error' || snapshot.phase === 'unavailable')}
        <button
          type="button"
          onclick={retry}
          disabled={retrying}
          class="relative mt-5 min-h-10 rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-zinc-100 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]
            {retrying ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' : 'bg-zinc-100 text-zinc-950 hover:bg-white cursor-pointer'}"
        >
          {retrying ? 'Retrying…' : 'Retry managed server'}
        </button>
      {/if}

      {#if model && snapshot.phase === 'downloading'}
        <p class="relative mt-4 text-xs text-zinc-400">
          {#if typeof model.downloaded_bytes === 'number' && typeof model.total_bytes === 'number' && model.total_bytes > 0}
            Download progress is available in the preparation banner.
          {:else}
            Downloading with progress details still being established.
          {/if}
        </p>
      {/if}
    </section>

    <section data-home-modes class="grid gap-3 sm:grid-cols-2" aria-label="Dictation shortcuts and guidance">
      <article class="group min-w-0 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 transition-colors hover:border-white/20 hover:bg-white/[0.04]">
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-xs font-medium text-zinc-300">Quick</p>
            <h2 class="mt-1 text-base font-semibold text-zinc-100">Say it. Send it.</h2>
            <p class="mt-1 text-xs leading-5 text-zinc-500">Short, immediate speech-to-text input.</p>
          </div>
          <span aria-hidden="true" class="text-lg text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-200">→</span>
        </div>
        <p class="mt-4 inline-flex max-w-full rounded-lg bg-black/25 px-2.5 py-1.5 font-mono text-xs text-zinc-300 [overflow-wrap:anywhere]">{quickHotkey}</p>
      </article>
      <article class="group min-w-0 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 transition-colors hover:border-white/20 hover:bg-white/[0.04]">
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-xs font-medium text-zinc-300">Long</p>
            <h2 class="mt-1 text-base font-semibold text-zinc-100">Keep the thought flowing.</h2>
            <p class="mt-1 text-xs leading-5 text-zinc-500">Longer recordings are processed after capture.</p>
          </div>
          <span aria-hidden="true" class="text-lg text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-200">→</span>
        </div>
        <p class="mt-4 inline-flex max-w-full rounded-lg bg-black/25 px-2.5 py-1.5 font-mono text-xs text-zinc-300 [overflow-wrap:anywhere]">{longHotkey}</p>
      </article>
    </section>

    <div class="flex min-w-0 flex-col gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.018] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <h2 id="home-privacy-heading" class="text-sm font-medium text-zinc-200">Private by default</h2>
        <p class="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">Packaged Eve uses its managed local service for speech. During development, Eve may use a separately started localhost service. Eve keeps the Murmur legacy profile untouched and does not automatically import personal data.</p>
        {#if shortcutsError}<p class="mt-2 text-xs text-zinc-500">Shortcut labels could not be read. Open Settings to review them.</p>{/if}
      </div>
      <span class="shrink-0 rounded-full border border-emerald-300/15 bg-emerald-300/[0.05] px-3 py-1.5 text-xs text-emerald-300">Local-first</span>
    </div>

    <nav aria-label="Home actions" class="flex min-w-0 flex-wrap items-center gap-1 text-xs">
      <span class="mr-2 text-zinc-600">Explore</span>
      <button type="button" onclick={() => onNavigate('history')} class="rounded-full px-3 py-2 text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-100 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-zinc-100">History</button>
      <button type="button" onclick={() => onNavigate('insights')} class="rounded-full px-3 py-2 text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-100 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-zinc-100">Insights</button>
      <button type="button" onclick={() => onNavigate('settings')} class="rounded-full px-3 py-2 text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-100 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-zinc-100">Settings</button>
    </nav>

    {#if engine && reportedLanguages.length > 0}
      <p class="sr-only">Languages reported by the current engine: {reportedLanguages.join(', ')}.</p>
    {/if}
</PrimaryPage>
