<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { toast } from '$lib/toast.svelte';
  import type { HistoryEntryWithGroup, HistoryFilters } from '$shared/types';
  import PrimaryPage from '../components/PrimaryPage.svelte';

  const BATCH_SIZE = 30;

  // State
  let history: HistoryEntryWithGroup[] = $state([]);
  let hasMore = $state(true);
  let loading = $state(false);
  let loadError = $state('');
  let offset = $state(0);
  let requestGeneration = 0;
  let resetQueued = false;

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
  let deleteDialog: HTMLDivElement | undefined = $state(undefined);
  let deleteTrigger: HTMLElement | null = null;
  let bulkDeleteConfirmOpen = $state(false);
  let bulkDeleteDialog: HTMLDivElement | undefined = $state(undefined);
  let bulkDeleteTrigger: HTMLElement | null = null;
  let selectionToggle: HTMLButtonElement | undefined;

  // Selection mode
  let selectionMode = $state(false);
  let selectedIds = $state<Set<string>>(new Set());
  let selectingAll = $state(false);
  let bulkDeleting = $state(false);
  let selectionFeedback = $state('');
  let selectionGeneration = 0;
  let selectedCount = $derived(selectedIds.size);
  let hasSelection = $derived(selectedCount > 0);

  $effect(() => {
    if (deleteConfirmId) queueMicrotask(() => deleteDialog?.focus());
  });

  $effect(() => {
    if (bulkDeleteConfirmOpen) queueMicrotask(() => bulkDeleteDialog?.focus());
  });

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

  function clearSelection(): void {
    selectionGeneration += 1;
    selectedIds = new Set();
    selectionFeedback = '';
  }

  function enterSelectionMode(): void {
    selectionMode = true;
    clearSelection();
  }

  function exitSelectionMode(): void {
    selectionMode = false;
    clearSelection();
  }

  function toggleSelectionMode(): void {
    if (selectionMode) exitSelectionMode();
    else enterSelectionMode();
  }

  function removeEntryFromSelection(id: string): void {
    if (!selectedIds.has(id)) return;
    const next = new Set(selectedIds);
    next.delete(id);
    selectedIds = next;
  }

  function toggleEntrySelection(id: string, selected: boolean): void {
    const next = new Set(selectedIds);
    if (selected) next.add(id);
    else next.delete(id);
    selectedIds = next;
    selectionFeedback = '';
  }

  async function selectAllCurrentFilter(): Promise<void> {
    if (selectingAll || bulkDeleting) return;
    const generation = ++selectionGeneration;
    selectingAll = true;
    selectionFeedback = '';
    try {
      const ids = await window.murmurMain.getHistoryEntryIds(buildFilters());
      if (generation !== selectionGeneration) return;
      selectedIds = new Set(ids);
      if (ids.length === 0) selectionFeedback = 'No entries match the current filters.';
    } catch (err) {
      if (generation !== selectionGeneration) return;
      console.error('Failed to select history entries:', err);
      selectionFeedback = 'History could not be selected. Try again.';
    } finally {
      selectingAll = false;
    }
  }

  // Load entries
  async function loadEntries(reset = false) {
    if (reset) {
      if (selectionMode || selectedIds.size > 0) exitSelectionMode();
      requestGeneration += 1;
      offset = 0;
      hasMore = true;
      history = [];
    }

    if (loading) {
      resetQueued ||= reset;
      return;
    }

    if (!hasMore) return;

    const generation = requestGeneration;
    const requestOffset = offset;
    const filters = buildFilters();
    loading = true;
    loadError = '';
    try {
      const response = await window.murmurMain.getHistoryEntries(
        requestOffset,
        BATCH_SIZE,
        filters
      );
      if (generation !== requestGeneration) return;

      history = reset ? response.entries : [...history, ...response.entries];
      hasMore = response.hasMore;
      offset = requestOffset + response.entries.length;
      lastUpdated = Date.now();
    } catch (err) {
      if (generation === requestGeneration) {
        console.error('Failed to load history:', err);
        loadError = 'History could not be loaded. Check that Eve is ready, then try again.';
      }
    } finally {
      loading = false;
      if (resetQueued) {
        resetQueued = false;
        void loadEntries(true);
      }
    }
  }

  // Debounced search
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  function handleSearchInput() {
    clearSelection();
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      loadEntries(true);
    }, 300);
  }

  // Filter changes
  function handleFilterChange() {
    clearSelection();
    loadEntries(true);
  }

  function clearFilters() {
    dateFrom = '';
    dateTo = '';
    minDuration = '';
    maxDuration = '';
    minConfidence = '';
    editedOnly = false;
    clearSelection();
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
    deleteTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    deleteConfirmId = id;
  }

  function closeDeleteDialog() {
    deleteConfirmId = null;
    const trigger = deleteTrigger;
    deleteTrigger = null;
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }

  async function confirmDelete() {
    if (!deleteConfirmId) return;
    const id = deleteConfirmId;
    try {
      await window.murmurMain.deleteHistoryEntry(id);
      history = history.filter((item) => item.id !== id);
      removeEntryFromSelection(id);
      toast('Transcription deleted', 'info');
    } catch (err) {
      console.error('Failed to delete:', err);
      toast('Failed to delete', 'error');
    }
    closeDeleteDialog();
  }

  function cancelDelete() {
    closeDeleteDialog();
  }

  function openBulkDeleteDialog(): void {
    if (!hasSelection || bulkDeleting) return;
    bulkDeleteTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selectionFeedback = '';
    bulkDeleteConfirmOpen = true;
  }

  function closeBulkDeleteDialog(): void {
    bulkDeleteConfirmOpen = false;
    const trigger = bulkDeleteTrigger;
    bulkDeleteTrigger = null;
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
      else selectionToggle?.focus();
    });
  }

  function cancelBulkDelete(): void {
    exitSelectionMode();
    closeBulkDeleteDialog();
  }

  async function confirmBulkDelete(): Promise<void> {
    if (bulkDeleting || !hasSelection) return;
    const ids = [...selectedIds];
    const requestedCount = ids.length;
    bulkDeleting = true;
    selectionFeedback = '';
    try {
      const result = await window.murmurMain.deleteHistoryEntries(ids);
      exitSelectionMode();
      closeBulkDeleteDialog();
      await loadEntries(true);
      if (result.missingIds.length > 0) {
        toast(`Deleted ${result.deletedCount} of ${requestedCount} selected entries; ${result.missingIds.length} were already gone.`, 'info');
      } else {
        toast(`Deleted ${result.deletedCount} selected ${result.deletedCount === 1 ? 'entry' : 'entries'}.`, 'info');
      }
    } catch (err) {
      console.error('Failed to delete selected history:', err);
      selectionFeedback = 'History could not be deleted. Nothing was removed. Try again.';
      toast('Failed to delete selected entries', 'error');
    } finally {
      bulkDeleting = false;
    }
  }

  function getActiveConfirmationDialog(): HTMLDivElement | undefined {
    return deleteConfirmId ? deleteDialog : bulkDeleteConfirmOpen ? bulkDeleteDialog : undefined;
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    const activeDialog = getActiveConfirmationDialog();
    if (!activeDialog) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (deleteConfirmId) cancelDelete();
      else if (!bulkDeleting) cancelBulkDelete();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = Array.from(
        activeDialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        event.preventDefault();
        activeDialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
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

  function isLastInGroup(index: number): boolean {
    if (index === history.length - 1) return true;
    return history[index]?.dateGroup !== history[index + 1]?.dateGroup;
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
    const unsubscribeNewHistoryEntry = window.murmurMain.onNewHistoryEntry((entry) => {
      // Prepend new entry if it passes current filters
      const filters = buildFilters();
      let shouldAdd = true;

      if (filters?.text && !entry.text.toLowerCase().includes(filters.text.toLowerCase())) {
        shouldAdd = false;
      }
      if (filters?.dateFrom && entry.timestamp < filters.dateFrom) {
        shouldAdd = false;
      }
      if (filters?.dateTo && entry.timestamp > filters.dateTo) {
        shouldAdd = false;
      }
      if (filters?.minDuration !== undefined && entry.audioDuration < filters.minDuration) {
        shouldAdd = false;
      }
      if (filters?.maxDuration !== undefined && entry.audioDuration > filters.maxDuration) {
        shouldAdd = false;
      }
      if (filters?.minConfidence !== undefined && entry.confidence < filters.minConfidence) {
        shouldAdd = false;
      }
      if (filters?.editedOnly && entry.editedAt === undefined) {
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
      unsubscribeNewHistoryEntry();
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

<svelte:window onkeydown={handleWindowKeydown} />

<PrimaryPage page="history" scrollOwner="history" contentClass="pb-4">
<div class="mx-auto flex min-h-full w-full max-w-[560px] flex-col">
  <!-- Search Bar -->
  <div class="pb-3 pr-3">
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
        aria-label="Search transcriptions"
        placeholder="Search transcriptions..."
        bind:value={searchQuery}
        oninput={handleSearchInput}
        class="w-full bg-zinc-900/65 border border-white/10 rounded-full
          pl-10 pr-12 py-2 text-[13px] text-zinc-100 placeholder-zinc-500
          focus:outline-none focus:border-zinc-700 focus:bg-zinc-900"
      />
      <!-- Filter toggle button -->
      <button
        type="button"
        onclick={() => (showFilters = !showFilters)}
        aria-label="Toggle history filters"
        aria-expanded={showFilters}
        class="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-colors cursor-pointer
          {showFilters || hasActiveFilters ? 'text-zinc-200 bg-white/[0.08]' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}"
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
                class="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-zinc-200
                  focus:ring-zinc-200 focus:ring-offset-0 cursor-pointer"
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

    <div data-history-selection-toolbar class="mt-3 flex min-w-0 flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.018] p-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        {#if selectionMode}
          <p data-history-selection-count class="text-xs text-zinc-200" aria-live="polite">{selectedCount} selected</p>
          <p class="mt-1 text-[11px] text-zinc-500">Selection applies to the current filters.</p>
        {:else}
          <p class="text-xs text-zinc-500">Select entries to delete more than one at a time.</p>
        {/if}
        {#if selectionFeedback && !bulkDeleteConfirmOpen}
          <p data-history-selection-feedback class="mt-1 text-xs text-red-300" role="alert">{selectionFeedback}</p>
        {/if}
      </div>
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          data-history-selection-toggle
          bind:this={selectionToggle}
          aria-pressed={selectionMode}
          onclick={toggleSelectionMode}
          class="min-h-9 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
        >
          {selectionMode ? 'Exit selection' : 'Select entries'}
        </button>
        {#if selectionMode}
          <button
            type="button"
            data-history-select-all
            aria-label="Select all entries in the current filter"
            aria-busy={selectingAll}
            disabled={selectingAll || bulkDeleting}
            onclick={selectAllCurrentFilter}
            class="min-h-9 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {selectingAll ? 'Selecting…' : 'Select all'}
          </button>
          <button
            type="button"
            data-history-clear-selection
            disabled={!hasSelection || selectingAll || bulkDeleting}
            onclick={clearSelection}
            class="min-h-9 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear selection
          </button>
          <button
            type="button"
            data-history-delete-selected
            disabled={!hasSelection || selectingAll || bulkDeleting}
            aria-busy={bulkDeleting}
            onclick={openBulkDeleteDialog}
            class="min-h-9 rounded-lg bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-950 transition-colors hover:bg-white cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {bulkDeleting ? 'Deleting…' : 'Delete selected'}
          </button>
        {/if}
      </div>
    </div>

  </div>

  <!-- History List -->
  <div class="flex-1 pr-3">
    {#if loadError}
      <div class="rounded-[10px] border border-red-400/40 bg-red-950/30 p-4" role="alert">
        <p class="text-sm text-red-200">{loadError}</p>
        <button
          type="button"
          onclick={() => loadEntries(true)}
          class="mt-3 rounded-md border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/[0.09] cursor-pointer"
        >
          Try again
        </button>
      </div>
    {:else if history.length === 0 && !loading}
      <div class="text-center py-12 text-zinc-500 text-sm">
        {searchQuery || hasActiveFilters ? 'No matching transcriptions' : 'No transcriptions yet'}
      </div>
    {:else}
      <div>
        {#each history as item, index (item.id)}
          {@const isExpanded = expandedId === item.id}
          {@const showHeader = isFirstInGroup(index)}
          {@const closeGroup = isLastInGroup(index)}

          <!-- Date Group Header -->
          {#if showHeader}
            <div class="pt-4 pb-2 first:pt-0 flex items-center justify-between">
              <span class="text-[11px] font-medium text-zinc-500 uppercase tracking-[0.08em]">
                {item.dateGroup}
              </span>
              {#if index === 0 && lastUpdated}
                <span class="text-[11px] text-zinc-500">
                  Updated {formatFullDate(lastUpdated)}
                </span>
              {/if}
            </div>
          {/if}

          <!-- Entry -->
          <div
            class="group min-w-0 overflow-hidden border border-white/[0.09] bg-white/[0.018] transition-colors duration-150
              {showHeader ? 'rounded-t-[8px]' : 'border-t-0'}
              {closeGroup ? 'rounded-b-[8px]' : ''}
              {isExpanded ? 'bg-white/[0.045]' : 'hover:bg-white/[0.035]'}"
          >
            <!-- Collapsed/Preview State -->
            <div class="px-3 py-3">
              <div class="flex items-center gap-3">
                {#if selectionMode}
                  <label class="flex shrink-0 items-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      disabled={selectingAll || bulkDeleting}
                      aria-label={`Select transcription from ${formatFullDate(item.timestamp)}`}
                      onchange={(event) => toggleEntrySelection(item.id, event.currentTarget.checked)}
                      class="h-4 w-4 cursor-pointer rounded border-zinc-700 bg-zinc-800 text-zinc-200 focus:ring-2 focus:ring-zinc-200 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </label>
                {/if}
                <button
                  type="button"
                  onclick={() => toggleExpand(item.id)}
                  aria-expanded={isExpanded}
                  class="flex-1 min-w-0 rounded-md text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]"
                >
                  <p class="max-w-full text-[13px] leading-[1.45] text-zinc-100 [overflow-wrap:anywhere] {isExpanded ? '' : 'line-clamp-2'}">
                    {item.text}
                  </p>
                  <p class="mt-1 text-[11px] text-zinc-500">
                    {formatTime(item.timestamp)}
                    {#if item.editedAt}
                      <span class="ml-2 text-zinc-500">edited</span>
                    {/if}
                  </p>
                </button>

                <!-- Quick Action Buttons (stacked vertically) -->
                <div class="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    onclick={(e) => { e.stopPropagation(); handleCopy(item.text); }}
                    aria-label="Copy transcription"
                    class="min-h-8 min-w-8 p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.09] rounded-md transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
                    title="Copy"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onclick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                    aria-label="Delete transcription"
                    class="min-h-8 min-w-8 p-1.5 text-zinc-400 hover:text-red-300 hover:bg-white/[0.09] rounded-md transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
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
                      <span class="text-zinc-300 ml-2">{Math.round(item.transcriptionTime)}ms</span>
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
</PrimaryPage>

<!-- Delete Confirmation Dialog -->
{#if deleteConfirmId}
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
    <div
      bind:this={deleteDialog}
      tabindex="-1"
      class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-sm mx-4 shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      aria-describedby="delete-dialog-description"
    >
      <h3 id="delete-dialog-title" class="text-lg font-medium text-zinc-100 mb-2">Delete Transcription?</h3>
      <p id="delete-dialog-description" class="text-sm text-zinc-400 mb-6">
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

{#if bulkDeleteConfirmOpen}
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
    <div
      bind:this={bulkDeleteDialog}
      tabindex="-1"
      class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-sm mx-4 shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-delete-dialog-title"
      aria-describedby="bulk-delete-dialog-description"
    >
      <h3 id="bulk-delete-dialog-title" class="text-lg font-medium text-zinc-100 mb-2">Delete {selectedCount} selected {selectedCount === 1 ? 'entry' : 'entries'}?</h3>
      <p id="bulk-delete-dialog-description" class="text-sm text-zinc-400 mb-4">
        This action cannot be undone. Exactly {selectedCount} selected {selectedCount === 1 ? 'entry will' : 'entries will'} be permanently removed from your history.
      </p>
      {#if selectionFeedback}
        <p data-bulk-delete-error class="mb-4 text-sm text-red-300" role="alert">{selectionFeedback}</p>
      {/if}
      <div class="flex gap-3 justify-end">
        <button
          type="button"
          onclick={cancelBulkDelete}
          disabled={bulkDeleting}
          class="px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={confirmBulkDelete}
          disabled={bulkDeleting}
          aria-busy={bulkDeleting}
          class="px-4 py-2 text-sm font-medium bg-zinc-100 hover:bg-white text-zinc-950 rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {bulkDeleting ? 'Deleting…' : `Delete ${selectedCount}`}
        </button>
      </div>
    </div>
  </div>
{/if}
