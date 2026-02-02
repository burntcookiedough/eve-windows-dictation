<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { toast } from '$lib/toast.svelte';
  import type { HistoryEntryWithGroup, HistoryFilters } from '$shared/types';

  const BATCH_SIZE = 30;

  // State
  let history: HistoryEntryWithGroup[] = $state([]);
  let hasMore = $state(true);
  let loading = $state(false);
  let offset = $state(0);

  // Search and filters
  let searchQuery = $state('');
  let showFilters = $state(false);
  let dateFrom = $state('');
  let dateTo = $state('');
  let minDuration = $state('');
  let maxDuration = $state('');
  let minConfidence = $state('');
  let editedOnly = $state(false);

  // Delete confirmation
  let deleteConfirmId: string | null = $state(null);

  // Expanded item
  let expandedId: string | null = $state(null);

  // Last updated timestamp
  let lastUpdated: number | null = $state(null);

  // Sentinel element ref
  let sentinel: HTMLElement | undefined = $state(undefined);

  // Build filters object from state
  function buildFilters(): HistoryFilters | undefined {
    const filters: HistoryFilters = {};
    let hasFilters = false;

    if (searchQuery.trim()) {
      filters.text = searchQuery.trim();
      hasFilters = true;
    }
    if (dateFrom) {
      filters.dateFrom = new Date(dateFrom).getTime();
      hasFilters = true;
    }
    if (dateTo) {
      // End of day
      filters.dateTo = new Date(dateTo).getTime() + 86400000 - 1;
      hasFilters = true;
    }
    if (minDuration) {
      filters.minDuration = parseFloat(minDuration);
      hasFilters = true;
    }
    if (maxDuration) {
      filters.maxDuration = parseFloat(maxDuration);
      hasFilters = true;
    }
    if (minConfidence) {
      filters.minConfidence = parseFloat(minConfidence) / 100;
      hasFilters = true;
    }
    if (editedOnly) {
      filters.editedOnly = true;
      hasFilters = true;
    }

    return hasFilters ? filters : undefined;
  }

  // Load entries
  async function loadEntries(reset = false) {
    if (loading) return;

    if (reset) {
      offset = 0;
      hasMore = true;
      history = [];
    }

    if (!hasMore) return;

    loading = true;
    try {
      const filters = buildFilters();
      const response = await window.murmurMain.getHistoryEntries(offset, BATCH_SIZE, filters);
      history = reset ? response.entries : [...history, ...response.entries];
      hasMore = response.hasMore;
      offset += response.entries.length;
      lastUpdated = Date.now();
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      loading = false;
    }
  }

  // Debounced search
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  function handleSearchInput() {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      loadEntries(true);
    }, 300);
  }

  // Filter changes
  function handleFilterChange() {
    loadEntries(true);
  }

  function clearFilters() {
    dateFrom = '';
    dateTo = '';
    minDuration = '';
    maxDuration = '';
    minConfidence = '';
    editedOnly = false;
    loadEntries(true);
  }

  // Format functions
  function formatTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 1000 * 60) return 'Just now';
    if (diff < 1000 * 60 * 60) return `${Math.floor(diff / 1000 / 60)}m ago`;
    if (diff < 1000 * 60 * 60 * 24) return `${Math.floor(diff / 1000 / 60 / 60)}h ago`;
    return `${Math.floor(diff / 1000 / 60 / 60 / 24)}d ago`;
  }

  function formatFullDate(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  function countWords(text: string): number {
    return text.split(/\s+/).filter((w) => w.length > 0).length;
  }

  function calcWordsPerMinute(text: string, audioDurationSec: number): number {
    if (audioDurationSec <= 0) return 0;
    const words = countWords(text);
    return words / (audioDurationSec / 60);
  }

  function calcPerformanceRatio(audioDurationSec: number, processingTimeMs: number): number {
    if (processingTimeMs <= 0) return 0;
    return audioDurationSec / (processingTimeMs / 1000);
  }

  // Actions
  function handleCopy(text: string) {
    window.murmurMain.copyToClipboard(text);
    toast('Copied to clipboard');
  }

  function handleDelete(id: string) {
    deleteConfirmId = id;
  }

  async function confirmDelete() {
    if (!deleteConfirmId) return;
    try {
      await window.murmurMain.deleteHistoryEntry(deleteConfirmId);
      history = history.filter((item) => item.id !== deleteConfirmId);
      toast('Transcription deleted', 'info');
    } catch (err) {
      console.error('Failed to delete:', err);
      toast('Failed to delete', 'error');
    }
    deleteConfirmId = null;
  }

  function cancelDelete() {
    deleteConfirmId = null;
  }

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  // Get unique date groups in order
  let dateGroups = $derived(() => {
    const groups: string[] = [];
    let lastGroup = '';
    for (const item of history) {
      if (item.dateGroup !== lastGroup) {
        groups.push(item.dateGroup);
        lastGroup = item.dateGroup;
      }
    }
    return groups;
  });

  // Check if item is first in its date group
  function isFirstInGroup(index: number): boolean {
    if (index === 0) return true;
    return history[index]?.dateGroup !== history[index - 1]?.dateGroup;
  }

  // Check if any filters are active
  let hasActiveFilters = $derived(
    dateFrom || dateTo || minDuration || maxDuration || minConfidence || editedOnly
  );

  onMount(() => {
    // Initial load
    loadEntries(true);

    // Reload when window becomes visible again (e.g., reopened from tray)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadEntries(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Listen for new entries
    window.murmurMain.onNewHistoryEntry((entry) => {
      // Prepend new entry if it passes current filters
      const filters = buildFilters();
      let shouldAdd = true;

      if (filters?.text && !entry.text.toLowerCase().includes(filters.text.toLowerCase())) {
        shouldAdd = false;
      }
      if (filters?.dateFrom && entry.timestamp < filters.dateFrom) {
        shouldAdd = false;
      }
      if (filters?.minConfidence && entry.confidence < filters.minConfidence) {
        shouldAdd = false;
      }

      if (shouldAdd) {
        history = [entry, ...history];
        offset += 1;
        lastUpdated = Date.now();
      }
    });

    // Set up intersection observer for infinite scroll
    let observer: IntersectionObserver | null = null;

    // Wait for sentinel to be mounted
    const setupObserver = () => {
      if (!sentinel) return;

      observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting && hasMore && !loading) {
            loadEntries();
          }
        },
        { rootMargin: '200px' }
      );

      observer.observe(sentinel);
    };

    // Try to set up observer after a tick
    setTimeout(setupObserver, 0);

    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.murmurMain.removeNewHistoryEntryListener();
      if (searchTimeout) clearTimeout(searchTimeout);
    };
  });

  // Re-observe when sentinel changes
  $effect(() => {
    if (sentinel && hasMore && !loading) {
      // Trigger a load check when we have a sentinel
    }
  });
</script>

<div class="h-full flex flex-col p-6 pr-2">
  <!-- Search Bar -->
  <div class="pb-4 pr-4">
    <div class="relative">
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
        oninput={handleSearchInput}
        class="w-full bg-zinc-900/80 border border-zinc-800 rounded-full
          pl-10 pr-12 py-2.5 text-sm text-zinc-100 placeholder-zinc-500
          focus:outline-none focus:border-zinc-700 focus:bg-zinc-900"
      />
      <!-- Filter toggle button -->
      <button
        onclick={() => (showFilters = !showFilters)}
        class="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-colors cursor-pointer
          {showFilters || hasActiveFilters ? 'text-blue-400 bg-blue-950/50' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}"
        title="Filters"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
        </svg>
      </button>
    </div>

    <!-- Expandable Filters -->
    {#if showFilters}
      <div class="mt-3 p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl" transition:slide={{ duration: 200, easing: quintOut }}>
        <div class="grid grid-cols-2 gap-4">
          <!-- Date Range -->
          <label class="block">
            <span class="block text-xs text-zinc-500 mb-1.5">From Date</span>
            <input
              type="date"
              bind:value={dateFrom}
              onchange={handleFilterChange}
              class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100
                focus:outline-none focus:border-zinc-600"
            />
          </label>
          <label class="block">
            <span class="block text-xs text-zinc-500 mb-1.5">To Date</span>
            <input
              type="date"
              bind:value={dateTo}
              onchange={handleFilterChange}
              class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100
                focus:outline-none focus:border-zinc-600"
            />
          </label>

          <!-- Duration -->
          <label class="block">
            <span class="block text-xs text-zinc-500 mb-1.5">Min Duration (s)</span>
            <input
              type="number"
              bind:value={minDuration}
              onchange={handleFilterChange}
              min="0"
              step="0.1"
              placeholder="0"
              class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100
                focus:outline-none focus:border-zinc-600 placeholder-zinc-600"
            />
          </label>
          <label class="block">
            <span class="block text-xs text-zinc-500 mb-1.5">Max Duration (s)</span>
            <input
              type="number"
              bind:value={maxDuration}
              onchange={handleFilterChange}
              min="0"
              step="0.1"
              placeholder="No limit"
              class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100
                focus:outline-none focus:border-zinc-600 placeholder-zinc-600"
            />
          </label>

          <!-- Confidence -->
          <label class="block">
            <span class="block text-xs text-zinc-500 mb-1.5">Min Confidence (%)</span>
            <input
              type="number"
              bind:value={minConfidence}
              onchange={handleFilterChange}
              min="0"
              max="100"
              step="5"
              placeholder="0"
              class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100
                focus:outline-none focus:border-zinc-600 placeholder-zinc-600"
            />
          </label>

          <!-- Edited Only -->
          <div class="flex items-end">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                bind:checked={editedOnly}
                onchange={handleFilterChange}
                class="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-blue-500
                  focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
              />
              <span class="text-sm text-zinc-300">Edited only</span>
            </label>
          </div>
        </div>

        {#if hasActiveFilters}
          <div class="mt-4 pt-3 border-t border-zinc-800">
            <button
              onclick={clearFilters}
              class="text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
            >
              Clear all filters
            </button>
          </div>
        {/if}
      </div>
    {/if}

  </div>

  <!-- History List -->
  <div class="flex-1 overflow-y-auto pr-4">
    {#if history.length === 0 && !loading}
      <div class="text-center py-12 text-zinc-500 text-sm">
        {searchQuery || hasActiveFilters ? 'No matching transcriptions' : 'No transcriptions yet'}
      </div>
    {:else}
      <div class="space-y-2">
        {#each history as item, index (item.id)}
          {@const isExpanded = expandedId === item.id}
          {@const showHeader = isFirstInGroup(index)}

          <!-- Date Group Header -->
          {#if showHeader}
            <div class="pt-4 pb-2 first:pt-0 flex items-center justify-between">
              <span class="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                {item.dateGroup}
              </span>
              {#if index === 0 && lastUpdated}
                <span class="text-xs text-zinc-600">
                  Updated {formatFullDate(lastUpdated)}
                </span>
              {/if}
            </div>
          {/if}

          <!-- Entry -->
          <div
            class="group rounded-2xl border border-zinc-800/60 transition-all duration-200
              {isExpanded ? 'bg-zinc-900 border-zinc-800' : 'hover:bg-zinc-900/50 hover:border-zinc-800'}"
          >
            <!-- Collapsed/Preview State -->
            <div
              class="p-4 cursor-pointer"
              onclick={() => toggleExpand(item.id)}
              onkeydown={(e) => e.key === 'Enter' && toggleExpand(item.id)}
              role="button"
              tabindex="0"
            >
              <div class="flex items-start gap-3">
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-zinc-200 {isExpanded ? '' : 'line-clamp-2'}">
                    {item.text}
                  </p>
                  <p class="text-xs text-zinc-500 mt-1.5">
                    {formatTime(item.timestamp)}
                    {#if item.editedAt}
                      <span class="ml-2 text-blue-400/70">edited</span>
                    {/if}
                  </p>
                </div>

                <!-- Quick Action Buttons (stacked vertically) -->
                <div class="flex flex-col gap-0.5 shrink-0 transition-opacity
                  {isExpanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}">
                  <button
                    onclick={(e) => { e.stopPropagation(); handleCopy(item.text); }}
                    class="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-md transition-colors cursor-pointer"
                    title="Copy"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                  </button>
                  <button
                    onclick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                    class="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-md transition-colors cursor-pointer"
                    title="Delete"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <!-- Expanded Details -->
            {#if isExpanded}
              {@const wordCount = countWords(item.text)}
              {@const wpm = calcWordsPerMinute(item.text, item.audioDuration)}
              {@const perfRatio = calcPerformanceRatio(item.audioDuration, item.transcriptionTime)}
              <div class="px-4 pb-4 pt-0" transition:slide={{ duration: 200, easing: quintOut }}>
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
                      <span class="text-zinc-500">Words</span>
                      <span class="text-zinc-300 ml-2">{wordCount}</span>
                    </div>
                    <div>
                      <span class="text-zinc-500">WPM</span>
                      <span class="text-zinc-300 ml-2">{Math.round(wpm)}</span>
                    </div>
                    <div>
                      <span class="text-zinc-500">Processing</span>
                      <span class="text-zinc-300 ml-2">{item.transcriptionTime.toFixed(3)}ms</span>
                    </div>
                    <div>
                      <span class="text-zinc-500">Performance</span>
                      <span class="text-zinc-300 ml-2">{perfRatio.toFixed(1)}x</span>
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

        <!-- Loading indicator / Sentinel -->
        <div bind:this={sentinel} class="py-4 flex justify-center">
          {#if loading}
            <div class="flex items-center gap-2 text-zinc-500 text-sm">
              <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>Loading...</span>
            </div>
          {:else if !hasMore && history.length > 0}
            <span class="text-zinc-600 text-xs">No more entries</span>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<!-- Delete Confirmation Dialog -->
{#if deleteConfirmId}
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-sm mx-4 shadow-xl">
      <h3 class="text-lg font-medium text-zinc-100 mb-2">Delete Transcription?</h3>
      <p class="text-sm text-zinc-400 mb-6">
        This action cannot be undone. The transcription will be permanently removed from your history.
      </p>
      <div class="flex gap-3 justify-end">
        <button
          onclick={cancelDelete}
          class="px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          onclick={confirmDelete}
          class="px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors cursor-pointer"
        >
          Delete
        </button>
      </div>
    </div>
  </div>
{/if}
