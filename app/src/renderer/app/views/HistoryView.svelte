<script lang="ts">
  import type { TranscriptionEntry } from '$shared/types';

  // TODO: Wire up to actual history from IPC
  let history: TranscriptionEntry[] = $state([]);
  let searchQuery = $state('');
  let expandedId: string | null = $state(null);

  // Filter history based on search
  let filteredHistory = $derived(
    history.filter(item =>
      item.text.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  function formatTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 1000 * 60 * 60) return `${Math.floor(diff / 1000 / 60)}m ago`;
    if (diff < 1000 * 60 * 60 * 24) return `${Math.floor(diff / 1000 / 60 / 60)}h ago`;
    return `${Math.floor(diff / 1000 / 60 / 60 / 24)}d ago`;
  }

  function formatFullDate(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  function handleCopy(text: string) {
    // TODO: Use IPC to copy to clipboard
    console.log('Copy:', text);
  }

  function handleDelete(id: string) {
    // TODO: Use IPC to delete from history
    console.log('Delete:', id);
  }

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }
</script>

<div class="h-full flex flex-col p-6 pr-2">
  <!-- Search Bar -->
  <div class="pb-4 pr-4">
    <div class="relative max-w-md">
      <svg
        class="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="2"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
      </svg>
      <input
        type="text"
        placeholder="Search transcriptions..."
        bind:value={searchQuery}
        class="w-full bg-zinc-900/80 border border-zinc-800 rounded-full
          pl-10 pr-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500
          focus:outline-none focus:border-zinc-700 focus:bg-zinc-900"
      />
    </div>
  </div>

  <!-- History List -->
  <div class="flex-1 overflow-y-auto pr-4">
    {#if filteredHistory.length === 0}
      <div class="text-center py-12 text-zinc-500 text-sm">
        {searchQuery ? 'No matching transcriptions' : 'No transcriptions yet'}
      </div>
    {:else}
      <div class="space-y-2">
        {#each filteredHistory as item (item.id)}
          {@const isExpanded = expandedId === item.id}
          <div
            class="group rounded-2xl transition-all duration-200
              {isExpanded ? 'bg-zinc-900 ring-1 ring-zinc-800' : 'hover:bg-zinc-900/50'}"
          >
            <!-- Collapsed/Preview State -->
            <div
              class="p-4 cursor-pointer"
              onclick={() => toggleExpand(item.id)}
              onkeydown={(e) => e.key === 'Enter' && toggleExpand(item.id)}
              role="button"
              tabindex="0"
            >
              <div class="flex items-start gap-4">
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-zinc-200 {isExpanded ? '' : 'line-clamp-2'}">
                    {item.text}
                  </p>
                  <p class="text-xs text-zinc-500 mt-1.5">
                    {formatTime(item.timestamp)}
                  </p>
                </div>

                <!-- Quick Action Buttons -->
                <div class="flex items-center gap-1 shrink-0 transition-opacity
                  {isExpanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}">
                  <button
                    onclick={(e) => { e.stopPropagation(); handleCopy(item.text); }}
                    class="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
                    title="Copy"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                  </button>
                  <button
                    onclick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                    class="p-2 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
                    title="Delete"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <!-- Expanded Details -->
            {#if isExpanded}
              <div class="px-4 pb-4 pt-0">
                <div class="pt-3 border-t border-zinc-800">
                  <!-- Metadata Grid -->
                  <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-xs mb-4">
                    <div>
                      <span class="text-zinc-500">Duration</span>
                      <span class="text-zinc-300 ml-2">{item.audioDuration.toFixed(1)}s</span>
                    </div>
                    <div>
                      <span class="text-zinc-500">Confidence</span>
                      <span class="text-zinc-300 ml-2">{Math.round(item.confidence * 100)}%</span>
                    </div>
                    <div>
                      <span class="text-zinc-500">Processing</span>
                      <span class="text-zinc-300 ml-2">{item.transcriptionTime}ms</span>
                    </div>
                    <div class="col-span-2 sm:col-span-3">
                      <span class="text-zinc-500">Timestamp</span>
                      <span class="text-zinc-300 ml-2">{formatFullDate(item.timestamp)}</span>
                    </div>
                  </div>

                  <!-- Action Buttons -->
                  <div class="flex gap-2">
                    <button
                      onclick={() => handleCopy(item.text)}
                      class="px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors cursor-pointer"
                    >
                      Copy Text
                    </button>
                    <button
                      onclick={() => handleDelete(item.id)}
                      class="px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950/50 rounded-lg transition-colors cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
