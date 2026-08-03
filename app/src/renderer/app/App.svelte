<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import TitleBar from './components/TitleBar.svelte';
  import Toasts from './components/Toasts.svelte';
  import HistoryView from './views/HistoryView.svelte';
  import InsightsView from './views/InsightsView.svelte';
  import SettingsView from './views/SettingsView.svelte';
  import HomeView from './views/HomeView.svelte';
  import TestView from './views/TestView.svelte';
  import ModelProgressBanner from './components/ModelProgressBanner.svelte';
  import { disposeServerStatus, initializeServerStatus, serverStatusState } from './server-status';

  type PrimaryView = 'home' | 'history' | 'insights' | 'settings';
  type View = PrimaryView | 'test';

  let activeView = $state<View>('home');
  let settingsVisited = $state(false);

  const primaryTabs: Array<{ id: PrimaryView; label: string }> = [
    { id: 'home', label: 'Home' },
    { id: 'history', label: 'History' },
    { id: 'insights', label: 'Insights' },
    { id: 'settings', label: 'Settings' },
  ];
  const developmentTabs: Array<{ id: View; label: string }> = import.meta.env.DEV
    ? [...primaryTabs, { id: 'test', label: 'Lab' }]
    : primaryTabs;

  function resolveView(candidate: string): View {
    const match = developmentTabs.find((tab) => tab.id === candidate);
    return match?.id ?? 'home';
  }

  function selectView(candidate: string) {
    const nextView = resolveView(candidate);
    if (nextView === 'settings') settingsVisited = true;
    activeView = nextView;
  }

  onMount(() => initializeServerStatus());
  onDestroy(disposeServerStatus);
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#08090a] text-zinc-100">
  <TitleBar />

  <header class="mt-2 flex h-12 shrink-0 items-center justify-center px-6">
    <nav
      aria-label="Main navigation"
      class="relative flex items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.03] p-0.5"
    >
      {#each developmentTabs as tab}
        <button
          type="button"
          onclick={() => selectView(tab.id)}
          aria-current={activeView === tab.id ? 'page' : undefined}
          class="relative min-h-7 rounded-full px-4 py-1 text-[12px] font-medium transition-colors duration-[180ms] cursor-pointer
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]
            {activeView === tab.id
              ? 'bg-white/[0.09] text-zinc-50'
              : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'}"
        >
          {tab.label}
        </button>
      {/each}
    </nav>
  </header>

  <ModelProgressBanner visible />
  <p class="sr-only" aria-live="polite" aria-atomic="true">{$serverStatusState.announcement}</p>

  <main id="main-content" class="min-h-0 min-w-0 flex-1 overflow-hidden" tabindex="-1">
    {#if activeView === 'home'}
      <HomeView onNavigate={selectView} />
    {/if}

    {#if activeView === 'history'}
      <HistoryView />
    {/if}

    {#if activeView === 'insights'}
      <InsightsView />
    {/if}

    {#if settingsVisited || activeView === 'settings'}
      <div class="h-full min-h-0 min-w-0" hidden={activeView !== 'settings'}>
        <SettingsView />
      </div>
    {/if}

    {#if import.meta.env.DEV && activeView === 'test'}
      <TestView />
    {/if}
  </main>
</div>

<!-- Toast notifications (outside main container for proper fixed positioning) -->
<Toasts />
