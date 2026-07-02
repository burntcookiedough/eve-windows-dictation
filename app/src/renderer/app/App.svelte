<script lang="ts">
  import TitleBar from './components/TitleBar.svelte';
  import Toasts from './components/Toasts.svelte';
  import HistoryView from './views/HistoryView.svelte';
  import InsightsView from './views/InsightsView.svelte';
  import SettingsView from './views/SettingsView.svelte';
  import TestView from './views/TestView.svelte';
  import ServerView from './views/ServerView.svelte';

  type View = 'history' | 'insights' | 'settings' | 'test' | 'server';

  let activeView = $state<View>('history');
  let settingsVisited = $state(false);

  const tabs: { id: View; label: string }[] = [
    { id: 'history', label: 'History' },
    { id: 'insights', label: 'Insights' },
    { id: 'settings', label: 'Settings' },
    { id: 'test', label: 'Lab' },
    { id: 'server', label: 'Server' },
  ];

  // Tab button refs for measuring pill position
  let tabRefs = $state<Record<View, HTMLButtonElement | null>>({
    history: null,
    insights: null,
    settings: null,
    test: null,
    server: null,
  });
  let navContainer: HTMLDivElement | null = $state(null);

  // Calculate pill position and clip-path for overlay
  let pillStyle = $derived.by(() => {
    const activeRef = tabRefs[activeView];
    if (!activeRef || !navContainer) return '';

    const containerRect = navContainer.getBoundingClientRect();
    const tabRect = activeRef.getBoundingClientRect();

    const left = tabRect.left - containerRect.left;
    const width = tabRect.width;

    return `left: ${left}px; width: ${width}px;`;
  });

  let clipPath = $derived.by(() => {
    const activeRef = tabRefs[activeView];
    if (!activeRef || !navContainer) return 'inset(0 100% 0 0 round 9999px)';

    const containerWidth = navContainer.offsetWidth;
    const tabLeft = activeRef.offsetLeft;
    const tabWidth = activeRef.offsetWidth;

    const leftPercent = (tabLeft / containerWidth) * 100;
    const rightPercent = 100 - ((tabLeft + tabWidth) / containerWidth) * 100;

    return `inset(0 ${rightPercent.toFixed(2)}% 0 ${leftPercent.toFixed(2)}% round 9999px)`;
  });
</script>

<div class="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
  <TitleBar />

  <!-- Header with Navigation Pills and Status -->
  <header class="h-14 flex items-center justify-between px-6 mt-3 shrink-0">
    <!-- Navigation Pills -->
    <div bind:this={navContainer} class="relative flex items-center gap-1 p-1 bg-zinc-900 rounded-full">
      <div
        class="absolute top-1 bottom-1 bg-zinc-100 rounded-full z-0 transition-[left,width] duration-200 ease-out
          {pillStyle ? 'opacity-100' : 'opacity-0'}"
        style={pillStyle}
      ></div>

      {#each tabs as tab}
        <button
          bind:this={tabRefs[tab.id]}
          onclick={() => {
            if (tab.id === 'settings') settingsVisited = true;
            activeView = tab.id;
          }}
          class="relative z-10 px-4 py-1.5 rounded-full text-sm font-medium cursor-pointer text-zinc-400 hover:text-zinc-300"
        >
          {tab.label}
        </button>
      {/each}

      <div
        aria-hidden="true"
        class="absolute inset-0 p-1 flex items-center gap-1 pointer-events-none z-20 transition-[clip-path] duration-200 ease-out"
        style="clip-path: {clipPath};"
      >
        {#each tabs as tab}
          <span class="px-4 py-1.5 text-sm font-medium text-zinc-900">
            {tab.label}
          </span>
        {/each}
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <main class="flex-1 overflow-hidden">
    {#if activeView === 'history'}
      <HistoryView />
    {/if}

    {#if activeView === 'insights'}
      <InsightsView />
    {/if}

    {#if settingsVisited || activeView === 'settings'}
      <div class="h-full" class:hidden={activeView !== 'settings'}>
        <SettingsView />
      </div>
    {/if}

    {#if activeView === 'test'}
      <TestView />
    {:else if activeView === 'server'}
      <ServerView />
    {/if}
  </main>
</div>

<!-- Toast notifications (outside main container for proper fixed positioning) -->
<Toasts />
