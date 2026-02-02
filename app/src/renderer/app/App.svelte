<script lang="ts">
  import TitleBar from './components/TitleBar.svelte';
  import Toasts from './components/Toasts.svelte';
  import HistoryView from './views/HistoryView.svelte';
  import SettingsView from './views/SettingsView.svelte';
  import TestView from './views/TestView.svelte';

  type View = 'history' | 'settings' | 'test';

  let activeView = $state<View>('history');

  // TODO: Wire up to actual state via IPC
  let isRecording = $state(false);
  let isConnected = $state(true);

  const tabs: { id: View; label: string }[] = [
    { id: 'history', label: 'History' },
    { id: 'settings', label: 'Settings' },
    { id: 'test', label: 'Test' },
  ];
</script>

<div class="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
  <TitleBar />

  <!-- Header with Navigation Pills and Status -->
  <header class="h-14 flex items-center justify-between px-6 mt-3 shrink-0">
    <!-- Navigation Pills -->
    <div class="flex items-center gap-1 p-1 bg-zinc-900 rounded-full">
      {#each tabs as tab}
        <button
          onclick={() => activeView = tab.id}
          class="px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 cursor-pointer
            {activeView === tab.id
              ? 'bg-zinc-100 text-zinc-900'
              : 'text-zinc-400 hover:text-zinc-200'
            }"
        >
          {tab.label}
        </button>
      {/each}
    </div>

    <!-- Status Indicators -->
    <div class="flex items-center gap-5">
      <!-- Recording Status -->
      <div class="flex items-center gap-2">
        <div class="w-2.5 h-2.5 rounded-full transition-colors
          {isRecording ? 'bg-red-500 animate-pulse' : 'bg-zinc-700'}"></div>
        <span class="text-xs text-zinc-500">
          {isRecording ? 'Recording' : 'Idle'}
        </span>
      </div>

      <!-- Connection Status -->
      <div class="flex items-center gap-2">
        <div class="w-2.5 h-2.5 rounded-full transition-colors
          {isConnected ? 'bg-emerald-500' : 'bg-amber-500'}"></div>
        <span class="text-xs text-zinc-500">
          {isConnected ? 'Connected' : 'Offline'}
        </span>
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <main class="flex-1 overflow-hidden">
    {#if activeView === 'history'}
      <HistoryView />
    {:else if activeView === 'settings'}
      <SettingsView />
    {:else if activeView === 'test'}
      <TestView />
    {/if}
  </main>
</div>

<!-- Toast notifications (outside main container for proper fixed positioning) -->
<Toasts />
