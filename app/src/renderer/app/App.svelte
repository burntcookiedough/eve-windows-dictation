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

</script>

<div class="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
  <TitleBar />

  <!-- Header with Navigation Pills and Status -->
  <header class="h-14 flex items-center justify-between px-6 mt-3 shrink-0">
    <!-- Navigation Pills -->
    <nav aria-label="Main navigation" class="relative flex items-center gap-1 p-1 bg-zinc-900 rounded-full">
      {#each tabs as tab}
        <button
          onclick={() => {
            if (tab.id === 'settings') settingsVisited = true;
            activeView = tab.id;
          }}
          aria-current={activeView === tab.id ? 'page' : undefined}
          class="relative px-4 py-1.5 rounded-full text-sm font-medium cursor-pointer transition-colors duration-200
            {activeView === tab.id
              ? 'bg-zinc-100 text-zinc-900'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}"
        >
          {tab.label}
        </button>
      {/each}
    </nav>
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
