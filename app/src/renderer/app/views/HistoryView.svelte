<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { toast } from '$lib/toast.svelte';
  import Cactus from '../components/Cactus.svelte';
  import type {
    DictationSessionMode,
    HistoryEntryWithGroup,
    HistoryExportFormat,
    HistoryExportRequest,
    HistoryFilters,
  } from '$shared/types';
  import EveDropdown from '../components/EveDropdown.svelte';
  import PrimaryPage from '../components/PrimaryPage.svelte';
  import {
    deferHistoryDelete,
    flushExpiredDeferredHistoryDeletes,
    flushDeferredHistoryDeletes,
    pendingHistoryDeletes,
    undoDeferredHistoryDelete,
  } from '../history-delete-queue.svelte';

  const BATCH_SIZE = 30;
  const HISTORY_EXPORT_FORMATS = [
    { value: 'json', label: 'JSON' },
    { value: 'csv', label: 'CSV' },
  ];
  type SessionFilter = 'all' | DictationSessionMode | 'edited';
  const SESSION_FILTERS: SessionFilter[] = ['all', 'quick', 'long', 'edited'];
  interface HistoryDayGroup {
    date: string;
    label: string;
    entries: HistoryEntryWithGroup[];
    words: number;
  }

  let history: HistoryEntryWithGroup[] = $state([]);
  let hasMore = $state(true);
  let loading = $state(false);
  let loadError = $state('');
  let offset = $state(0);
  let requestGeneration = 0;
  let resetQueued = false;
  let searchQuery = $state('');
  let showFilters = $state(false);
  let dateFrom = $state('');
  let dateTo = $state('');
  let minDuration = $state('');
  let maxDuration = $state('');
  let minConfidence = $state('');
  let sessionFilter = $state<SessionFilter>('all');
  let bulkDeleteConfirmOpen = $state(false);
  let bulkDeleteDialog: HTMLDivElement | undefined = $state(undefined);
  let bulkDeleteTrigger: HTMLElement | null = null;
  let selectionToggle: HTMLButtonElement | undefined = $state(undefined);
  let selectionMode = $state(false);
  let selectedIds = $state<Set<string>>(new Set());
  let selectingAll = $state(false);
  let bulkDeleting = $state(false);
  let exporting = $state(false);
  let exportFormat: HistoryExportFormat = $state('json');
  let selectionFeedback = $state('');
  let selectionGeneration = 0;
  let expandedId: string | null = $state(null);
  let sentinel: HTMLElement | undefined = $state(undefined);
  let historyRoot: HTMLElement | undefined = $state(undefined);
  let searchInput: HTMLInputElement | undefined = $state(undefined);
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;

  let pendingIds = $derived(new Set(pendingHistoryDeletes.items.map((item) => item.id)));
  let pendingDeletes = $derived(pendingHistoryDeletes.items);
  let visibleHistory = $derived(history.filter((item) => !pendingIds.has(item.id)));
  let dayGroups = $derived(groupHistoryByDay(visibleHistory));
  let selectedCount = $derived(selectedIds.size);
  let hasSelection = $derived(selectedCount > 0);
  let loadedWordCount = $derived(visibleHistory.reduce((sum, item) => sum + (item.wordCount ?? countWords(item.text)), 0));
  let loadedCountLabel = $derived(`${formatInteger(visibleHistory.length)}${hasMore ? '+' : ''} · ${formatInteger(loadedWordCount)}${hasMore ? '+' : ''} words`);
  let loadedCountDescription = $derived(`${visibleHistory.length} ${visibleHistory.length === 1 ? 'entry' : 'entries'} and ${formatInteger(loadedWordCount)} words loaded${hasMore ? ', more history is available' : ', all matching history is loaded'}`);
  let hasActiveFilters = $derived(Boolean(sessionFilter !== 'all' || dateFrom || dateTo || minDuration || maxDuration || minConfidence));

  function buildFilters(): HistoryFilters | undefined {
    const filters: HistoryFilters = {};
    let hasFilters = false;
    if (searchQuery.trim()) { filters.text = searchQuery.trim(); hasFilters = true; }
    if (sessionFilter === 'quick' || sessionFilter === 'long') { filters.sessionMode = sessionFilter; hasFilters = true; }
    if (sessionFilter === 'edited') { filters.editedOnly = true; hasFilters = true; }
    if (dateFrom) {
      const start = new Date(`${dateFrom}T00:00:00`);
      if (Number.isFinite(start.getTime())) { filters.dateFrom = start.getTime(); hasFilters = true; }
    }
    if (dateTo) {
      const end = new Date(`${dateTo}T00:00:00`);
      if (Number.isFinite(end.getTime())) { end.setHours(23, 59, 59, 999); filters.dateTo = end.getTime(); hasFilters = true; }
    }
    if (minDuration) { filters.minDuration = Number(minDuration); hasFilters = true; }
    if (maxDuration) { filters.maxDuration = Number(maxDuration); hasFilters = true; }
    if (minConfidence) { filters.minConfidence = Number(minConfidence) / 100; hasFilters = true; }
    return hasFilters ? filters : undefined;
  }

  function clearSelection(): void {
    selectionGeneration += 1;
    selectedIds = new Set();
    selectionFeedback = '';
  }

  function enterSelectionMode(): void { selectionMode = true; clearSelection(); }
  function exitSelectionMode(): void { selectionMode = false; clearSelection(); }
  function toggleSelectionMode(): void { selectionMode ? exitSelectionMode() : enterSelectionMode(); }

  function toggleEntrySelection(id: string, selected: boolean): void {
    const next = new Set(selectedIds);
    if (selected) next.add(id); else next.delete(id);
    selectedIds = next;
    selectionFeedback = '';
  }

  async function selectAllCurrentFilter(): Promise<void> {
    if (selectingAll || bulkDeleting || exporting) return;
    const generation = ++selectionGeneration;
    selectingAll = true;
    selectionFeedback = '';
    try {
      const ids = await window.murmurMain.getHistoryEntryIds(buildFilters());
      if (generation !== selectionGeneration) return;
      selectedIds = new Set(ids.filter((id) => !pendingIds.has(id)));
      if (selectedIds.size === 0) selectionFeedback = 'No entries match the current filters.';
    } catch (err) {
      if (generation !== selectionGeneration) return;
      console.error('Failed to select history entries:', err);
      selectionFeedback = 'History could not be selected. Try again.';
    } finally {
      selectingAll = false;
    }
  }

  async function loadEntries(reset = false): Promise<void> {
    if (reset) {
      if (selectionMode || selectedIds.size > 0) exitSelectionMode();
      requestGeneration += 1;
      offset = 0;
      hasMore = true;
      history = [];
    }
    if (loading) { resetQueued ||= reset; return; }
    if (!hasMore) return;

    const generation = requestGeneration;
    const requestOffset = offset;
    loading = true;
    loadError = '';
    try {
      const response = await window.murmurMain.getHistoryEntries(requestOffset, BATCH_SIZE, buildFilters());
      if (generation !== requestGeneration) return;
      history = reset ? response.entries : [...history, ...response.entries];
      hasMore = response.hasMore;
      offset = requestOffset + response.entries.length;
    } catch (err) {
      if (generation === requestGeneration) {
        console.error('Failed to load history:', err);
        loadError = 'History could not be loaded. Check that Eve is ready, then try again.';
      }
    } finally {
      loading = false;
      if (resetQueued) { resetQueued = false; void loadEntries(true); }
    }
  }

  function handleSearchInput(): void {
    clearSelection();
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => void loadEntries(true), 300);
  }

  function handleFilterChange(): void { clearSelection(); loadEntries(true); }

  function clearFilters(): void {
    dateFrom = '';
    dateTo = '';
    minDuration = '';
    maxDuration = '';
    minConfidence = '';
    sessionFilter = 'all';
    clearSelection();
    void loadEntries(true);
  }

  function formatClock(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function formatFullDate(timestamp: number): string { return new Date(timestamp).toLocaleString(); }
  function countWords(text: string): number { return text.trim().split(/\s+/).filter(Boolean).length; }
  function calcWordsPerMinute(text: string, audioDurationSec: number): number {
    return audioDurationSec > 0 ? countWords(text) / (audioDurationSec / 60) : 0;
  }
  function calcPerformanceRatio(audioDurationSec: number, processingTimeMs: number): number {
    return processingTimeMs > 0 ? audioDurationSec / (processingTimeMs / 1000) : 0;
  }
  function formatInteger(value: number): string { return Math.max(0, Math.round(Number.isFinite(value) ? value : 0)).toLocaleString(); }
  function formatDuration(seconds: number): string {
    const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    return value < 60 ? `${value.toFixed(1)}s` : `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
  }

  async function handleCopy(text: string): Promise<void> {
    try {
      await window.murmurMain.copyToClipboard(text);
      toast('Copied to clipboard');
    } catch (err) {
      console.error('Failed to copy history entry:', err);
      toast('Could not copy dictation', 'error');
    }
  }

  function handleDelete(id: string): void {
    if (pendingIds.has(id) || selectionMode) return;
    deferHistoryDelete(id);
    expandedId = null;
  }

  function undoDelete(id: string): void { undoDeferredHistoryDelete(id); }

  function openBulkDeleteDialog(): void {
    if (!hasSelection || bulkDeleting || exporting) return;
    bulkDeleteTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selectionFeedback = '';
    bulkDeleteConfirmOpen = true;
    void tick().then(() => {
      if (!bulkDeleteConfirmOpen) return;
      const firstButton = bulkDeleteDialog?.querySelector<HTMLButtonElement>('button:not([disabled])');
      (firstButton ?? bulkDeleteDialog)?.focus();
    });
  }

  function closeBulkDeleteDialog(): void {
    bulkDeleteConfirmOpen = false;
    const trigger = bulkDeleteTrigger;
    bulkDeleteTrigger = null;
    void tick().then(() => {
      if (trigger?.isConnected) trigger.focus();
      else selectionToggle?.focus();
    });
  }

  function cancelBulkDelete(): void { exitSelectionMode(); closeBulkDeleteDialog(); }

  async function confirmBulkDelete(): Promise<void> {
    if (bulkDeleting || exporting || !hasSelection) return;
    const ids = [...selectedIds].filter((id) => !pendingIds.has(id));
    const requestedCount = ids.length;
    bulkDeleting = true;
    selectionFeedback = '';
    try {
      const result = await window.murmurMain.deleteHistoryEntries(ids);
      if (result.deletedIds.length > 0) {
        window.dispatchEvent(new CustomEvent('history-delete-committed', { detail: { ids: result.deletedIds, deleted: true } }));
      }
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

  function changeExportFormat(value: string): void {
    if (value === 'json' || value === 'csv') exportFormat = value;
  }

  async function exportHistory(scope: 'all' | 'selected'): Promise<void> {
    if (exporting || bulkDeleting || selectingAll || (scope === 'selected' && !hasSelection)) return;
    const request: HistoryExportRequest = scope === 'selected'
      ? { format: exportFormat, scope, ids: [...selectedIds].filter((id) => !pendingIds.has(id)) }
      : { format: exportFormat, scope };
    exporting = true;
    selectionFeedback = '';
    try {
      const result = await window.murmurMain.exportHistory(request);
      if (result.status === 'cancelled') return;
      const format = exportFormat.toUpperCase();
      if (result.missingCount > 0) {
        toast(`Exported ${result.exportedCount} of ${result.requestedCount} selected entries as ${format}; ${result.missingCount} were no longer available.`, 'info');
      } else {
        toast(`Exported ${result.exportedCount} ${result.exportedCount === 1 ? 'entry' : 'entries'} as ${format}.`);
      }
    } catch (err) {
      console.error('Failed to export history:', err);
      selectionFeedback = 'History could not be exported. Nothing was written. Try again.';
      toast('Failed to export history', 'error');
    } finally {
      exporting = false;
    }
  }

  function toggleExpand(id: string): void { expandedId = expandedId === id ? null : id; }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (historyRoot?.closest('[inert]')) return;
    const activeDialog = bulkDeleteConfirmOpen ? bulkDeleteDialog : undefined;
    if (!activeDialog) {
      const target = event.target;
      if (event.key === '/' && target instanceof HTMLElement && !target.closest('input,textarea,select,[contenteditable="true"]')) {
        event.preventDefault();
        searchInput?.focus();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (bulkDeleting) return;
      else if (!bulkDeleting) cancelBulkDelete();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = Array.from(activeDialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) { event.preventDefault(); activeDialog.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  function onDeleteCommitted(event: Event): void {
    const detail = (event as CustomEvent<{ ids: string[]; deleted: boolean }>).detail;
    if (!detail?.deleted) return;
    const deletedIds = new Set(detail.ids);
    const removedCount = history.filter((item) => deletedIds.has(item.id)).length;
    history = history.filter((item) => !deletedIds.has(item.id));
    offset = Math.max(0, offset - removedCount);
    selectedIds = new Set([...selectedIds].filter((id) => !deletedIds.has(id)));
    if (expandedId && deletedIds.has(expandedId)) expandedId = null;
  }

  onMount(() => {
    void loadEntries(true);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        flushExpiredDeferredHistoryDeletes();
        void loadEntries(true);
      } else void flushDeferredHistoryDeletes();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const unsubscribeNewHistoryEntry = window.murmurMain.onNewHistoryEntry((entry) => {
      const filters = buildFilters();
      let shouldAdd = !filters?.text || entry.text.toLowerCase().includes(filters.text.toLowerCase());
      if (filters?.sessionMode && entry.sessionMode !== filters.sessionMode) shouldAdd = false;
      if (filters?.dateFrom !== undefined && entry.timestamp < filters.dateFrom) shouldAdd = false;
      if (filters?.dateTo !== undefined && entry.timestamp > filters.dateTo) shouldAdd = false;
      if (filters?.minDuration !== undefined && entry.audioDuration < filters.minDuration) shouldAdd = false;
      if (filters?.maxDuration !== undefined && entry.audioDuration > filters.maxDuration) shouldAdd = false;
      if (filters?.minConfidence !== undefined && entry.confidence < filters.minConfidence) shouldAdd = false;
      if (filters?.editedOnly && entry.editedAt === undefined) shouldAdd = false;
      if (pendingIds.has(entry.id)) shouldAdd = false;
      if (shouldAdd && !history.some((item) => item.id === entry.id)) {
        if (loading) {
          void loadEntries(true);
          return;
        }
        history = [entry, ...history];
        offset += 1;
      }
    });
    window.addEventListener('history-delete-committed', onDeleteCommitted);

    let observer: IntersectionObserver | null = null;
    const setupObserver = () => {
      if (!sentinel) return;
      const scrollRoot = document.querySelector<HTMLElement>('[data-scroll-owner="history"]');
      observer = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) void loadEntries();
      }, { root: scrollRoot, rootMargin: '200px' });
      observer.observe(sentinel);
    };
    const observerTimer = setTimeout(setupObserver, 0);

    return () => {
      observer?.disconnect();
      clearTimeout(observerTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('history-delete-committed', onDeleteCommitted);
      unsubscribeNewHistoryEntry();
      if (searchTimeout) clearTimeout(searchTimeout);
    };
  });

  function localDateKey(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function groupHistoryByDay(entries: HistoryEntryWithGroup[]): HistoryDayGroup[] {
    const groups: HistoryDayGroup[] = [];
    for (const entry of entries) {
      const date = localDateKey(entry.timestamp);
      let group = groups.at(-1);
      if (!group || group.date !== date) {
        group = { date, label: formatDayGroupLabel(entry.timestamp), entries: [], words: 0 };
        groups.push(group);
      }
      group.entries.push(entry);
      group.words += entry.wordCount ?? countWords(entry.text);
    }
    return groups;
  }

  function formatDayGroupLabel(timestamp: number): string {
    const current = new Date();
    const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
    const item = new Date(timestamp);
    const itemDay = new Date(item.getFullYear(), item.getMonth(), item.getDate());
    const difference = Math.round((today.getTime() - itemDay.getTime()) / 86400000);
    if (difference === 0) return 'Today';
    if (difference === 1) return 'Yesterday';
    return item.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function highlightSegments(text: string, query: string): Array<{ text: string; match: boolean }> {
    const needle = query.trim();
    if (!needle) return [{ text, match: false }];
    const lowerText = text.toLocaleLowerCase();
    const lowerNeedle = needle.toLocaleLowerCase();
    const segments: Array<{ text: string; match: boolean }> = [];
    let cursor = 0;
    let matchIndex = lowerText.indexOf(lowerNeedle, cursor);
    while (matchIndex >= 0) {
      if (matchIndex > cursor) segments.push({ text: text.slice(cursor, matchIndex), match: false });
      segments.push({ text: text.slice(matchIndex, matchIndex + needle.length), match: true });
      cursor = matchIndex + needle.length;
      matchIndex = lowerText.indexOf(lowerNeedle, cursor);
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
    return segments.length ? segments : [{ text, match: false }];
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<PrimaryPage page="history" scrollOwner="history" contentClass="pb-4">
  <main class="history-view" bind:this={historyRoot}>
    <div class="search-row" data-r style:--r={0}>
      <input
        bind:this={searchInput}
        type="search"
        aria-label="Search dictations"
        placeholder="Search dictations"
        autocomplete="off"
        spellcheck="false"
        bind:value={searchQuery}
        oninput={handleSearchInput}
      />
      <kbd>/</kbd>
    </div>

    <div class="history-toolbar" data-r style:--r={1}>
      <div class="filter-control-row">
        <div class="session-filters" role="group" aria-label="Filter dictations by type">
          {#each SESSION_FILTERS as filter (filter)}
            <button
              type="button"
              data-history-session-filter={filter}
              class:active={sessionFilter === filter}
              aria-pressed={sessionFilter === filter}
              onclick={() => { sessionFilter = filter; handleFilterChange(); }}
            >{filter}</button>
          {/each}
        </div>
        <button
          type="button"
          data-history-more-filters
          class="quiet-toggle"
          class:active={hasActiveFilters}
          class:open={showFilters}
          aria-label={hasActiveFilters ? 'More filters, active' : 'More filters'}
          aria-expanded={showFilters}
          onclick={() => showFilters = !showFilters}
        >
          <span>{showFilters ? 'less filters' : 'more filters'}</span><span class="filter-chevron" aria-hidden="true"></span>
        </button>
      </div>
      <div class="toolbar-actions" aria-label="History actions">
        <span class="entry-count" aria-live="polite" aria-label={loadedCountDescription}>{loadedCountLabel}</span>
        {#if !selectionMode}<button type="button" data-history-export-all class="text-action" aria-label="Export all history" aria-busy={exporting} disabled={exporting} onclick={() => exportHistory('all')}>{exporting ? 'exporting…' : 'export'}</button>{/if}
        <button type="button" data-history-selection-toggle class="text-action" bind:this={selectionToggle} aria-pressed={selectionMode} disabled={exporting} onclick={toggleSelectionMode}>{selectionMode ? 'done' : 'select'}</button>
      </div>
    </div>

    {#if showFilters}
      <div class="filters-panel">
        <label><span>From date</span><input type="date" bind:value={dateFrom} onchange={handleFilterChange} /></label>
        <label><span>To date</span><input type="date" bind:value={dateTo} onchange={handleFilterChange} /></label>
        <label><span>Min duration (s)</span><input type="number" min="0" step="0.1" placeholder="0" bind:value={minDuration} onchange={handleFilterChange} /></label>
        <label><span>Max duration (s)</span><input type="number" min="0" step="0.1" placeholder="No limit" bind:value={maxDuration} onchange={handleFilterChange} /></label>
        <label><span>Min confidence (%)</span><input type="number" min="0" max="100" step="5" placeholder="0" bind:value={minConfidence} onchange={handleFilterChange} /></label>
        {#if hasActiveFilters}<button class="text-action clear-filters" onclick={clearFilters}>Clear all filters</button>{/if}
      </div>
    {/if}

    {#if selectionMode}
    <div data-history-selection-toolbar class="selection-toolbar">
      <div class="selection-copy">
        <p data-history-selection-count aria-live="polite">{selectedCount} selected</p>
        <p class="selection-note">Selection applies to the current filters. Export all entries, or select a filtered subset.</p>
        {#if selectionFeedback && !bulkDeleteConfirmOpen}<p data-history-selection-feedback class="feedback" role="alert">{selectionFeedback}</p>{/if}
      </div>
      <div class="selection-actions">
        <EveDropdown label="History export format" value={exportFormat} options={HISTORY_EXPORT_FORMATS} onchange={changeExportFormat} disabled={exporting || bulkDeleting || selectingAll} />
        {#if selectionMode}
          <button type="button" data-history-select-all aria-busy={selectingAll} disabled={selectingAll || bulkDeleting || exporting} onclick={selectAllCurrentFilter}>{selectingAll ? 'Selecting…' : 'Select all'}</button>
          <button type="button" data-history-clear-selection disabled={!hasSelection || selectingAll || bulkDeleting || exporting} onclick={clearSelection}>Clear selection</button>
          <button type="button" data-history-export-selected disabled={!hasSelection || selectingAll || bulkDeleting || exporting} aria-busy={exporting} onclick={() => exportHistory('selected')}>{exporting ? 'Exporting…' : 'Export selected'}</button>
          <button type="button" aria-busy={exporting} disabled={exporting || bulkDeleting} onclick={() => exportHistory('all')}>{exporting ? 'Exporting…' : 'Export all'}</button>
          <button type="button" data-history-delete-selected class="delete-action" disabled={!hasSelection || selectingAll || bulkDeleting || exporting} aria-busy={bulkDeleting} onclick={openBulkDeleteDialog}>{bulkDeleting ? 'Deleting…' : 'Delete selected'}</button>
        {/if}
      </div>
    </div>
    {/if}

    {#if pendingDeletes.length > 0}
      <div class="undo-list" aria-live="polite">
        {#each pendingDeletes as pending (pending.id)}
          {@const pendingEntry = history.find((item) => item.id === pending.id)}
          <p>{pending.committing ? 'Deleting dictation…' : pendingEntry ? `Deleting dictation from ${formatClock(pendingEntry.timestamp)}` : 'Deleting dictation'}
            {#if !pending.committing}<button type="button" onclick={() => undoDelete(pending.id)}>Undo</button>{/if}
          </p>
        {/each}
      </div>
    {/if}

    {#if loadError}
      <div class="load-error" role="alert"><p>{loadError}</p><button type="button" onclick={() => loadEntries(true)}>Try again</button></div>
    {:else if visibleHistory.length === 0 && !loading && pendingDeletes.length === 0}
      <div class="empty-state" aria-live="polite">
        <Cactus class="empty-cactus" />
        <span>{searchQuery.trim() ? `Nothing matches “${searchQuery.trim()}”` : hasActiveFilters ? 'Nothing matches' : 'Nothing here yet'}</span>
      </div>
    {:else}
      <div class="history-list" data-r style:--r={2}>
        {#each dayGroups as group (group.date)}
          <section class="day-group" aria-labelledby={`history-day-${group.date}`}>
            <header class="day-header">
              <h2 id={`history-day-${group.date}`}>{group.label}</h2>
              <span aria-label={`${group.entries.length} ${group.entries.length === 1 ? 'dictation' : 'dictations'}, ${formatInteger(group.words)} words`}>{group.entries.length} · {formatInteger(group.words)} words</span>
            </header>
            {#each group.entries as item (item.id)}
              {@const isExpanded = expandedId === item.id}
              {@const wordCount = item.wordCount ?? countWords(item.text)}
              {@const wpm = calcWordsPerMinute(item.text, item.audioDuration)}
              {@const processingRatio = calcPerformanceRatio(item.audioDuration, item.transcriptionTime)}
              <article class="entry" data-history-entry={item.id} class:open={isExpanded}>
                <div class="entry-row">
                  {#if selectionMode}
                    <input
                      class="entry-check"
                      type="checkbox"
                      data-history-select-entry={item.id}
                      checked={selectedIds.has(item.id)}
                      disabled={selectingAll || bulkDeleting || exporting}
                      aria-label={`Select transcription from ${formatFullDate(item.timestamp)}`}
                      onchange={(event) => toggleEntrySelection(item.id, event.currentTarget.checked)}
                    />
                  {/if}
                  <button class="entry-preview" type="button" onclick={() => toggleExpand(item.id)} aria-expanded={isExpanded}>
                    <time>{formatClock(item.timestamp)}</time>
                    <span class="entry-text">
                      {#each highlightSegments(item.text, searchQuery) as segment, index (`${index}-${segment.text}`)}
                        {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                      {/each}
                    </span>
                    <span class="entry-duration">{formatDuration(item.audioDuration)}</span>
                  </button>
                </div>
                <div class="entry-more" class:expanded={isExpanded} aria-hidden={!isExpanded} inert={!isExpanded}>
                  <div class="entry-more-inner">
                    <div class="entry-more-summary">
                    <div class="entry-details" data-history-entry-metrics>
                      <span>{wordCount} words</span>
                      <span>{Math.round(Math.max(0, item.confidence) * 100)}% confidence</span>
                      <span>{Math.round(wpm)} wpm</span>
                      <span>{Math.round(Math.max(0, item.transcriptionTime))}ms processing</span>
                      <span>{processingRatio.toFixed(1)}x</span>
                      {#if item.sessionMode}<span>{item.sessionMode}</span>{/if}
                      {#if item.editedAt !== undefined}<span>edited</span>{/if}
                    </div>
                    <div class="entry-actions">
                      <button type="button" data-history-entry-copy onclick={() => handleCopy(item.text)}>Copy</button>
                      <button type="button" data-history-entry-delete disabled={pendingIds.has(item.id)} onclick={() => handleDelete(item.id)}>Delete</button>
                    </div>
                    </div>
                    <p class="entry-timestamp">{formatFullDate(item.timestamp)}</p>
                  </div>
                </div>
              </article>
            {/each}
          </section>
        {/each}
        <div bind:this={sentinel} class="list-end" aria-live="polite">
          {#if loading}<span>Loading…</span>{:else if !hasMore && visibleHistory.length > 0}<span>No more entries</span>{/if}
        </div>
      </div>
    {/if}
  </main>
</PrimaryPage>

{#if bulkDeleteConfirmOpen}
  <div class="dialog-backdrop">
    <div bind:this={bulkDeleteDialog} tabindex="-1" class="bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-dialog-title" aria-describedby="bulk-delete-dialog-description">
      <h2 id="bulk-delete-dialog-title">Delete {selectedCount} selected {selectedCount === 1 ? 'entry' : 'entries'}?</h2>
      <p id="bulk-delete-dialog-description">This action cannot be undone. Exactly {selectedCount} selected {selectedCount === 1 ? 'entry will' : 'entries will'} be permanently removed from your history.</p>
      {#if selectionFeedback}<p class="feedback" role="alert">{selectionFeedback}</p>{/if}
      <div class="dialog-actions">
        <button type="button" onclick={cancelBulkDelete} disabled={bulkDeleting}>Cancel</button>
        <button type="button" class="delete-action" onclick={confirmBulkDelete} disabled={bulkDeleting} aria-busy={bulkDeleting}>{bulkDeleting ? 'Deleting…' : `Delete ${selectedCount}`}</button>
      </div>
    </div>
  </div>
{/if}



<style>
  .history-view { width: 100%; max-width: 760px; margin: 0 auto; padding: 0 0 24px; color: var(--fg); }
  .search-row { display: flex; align-items: center; gap: 12px; padding: 22px 0 12px; border-bottom: 1px solid var(--line2); transition: border-color .3s var(--ease); }
  .search-row:focus-within { border-color: var(--fg2); }
  .search-row input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; color: var(--fg); font: inherit; font-size: 21px; font-weight: 300; letter-spacing: -.01em; }
  .search-row input::placeholder { color: var(--fg3); }
  .search-row input::-webkit-search-cancel-button { filter: grayscale(1); opacity: .55; }
  .search-row kbd { padding: 1px 6px; border: 1px solid var(--line2); border-radius: 3px; color: var(--fg3); font: 10px var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .history-toolbar { display: flex; min-width: 0; flex-direction: column; gap: 0; padding: 14px 0 4px; font-size: 12px; }
  .filter-control-row { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 14px; }
  .session-filters, .toolbar-actions { display: flex; min-width: 0; align-items: center; }
  .session-filters { flex: none; gap: 16px; }
  .toolbar-actions { width: 100%; justify-content: flex-end; gap: 16px; padding: 7px 0 6px; }
  .history-toolbar button, .selection-actions button, .entry-actions button, .dialog-actions button { color: var(--fg3); transition: color .2s var(--ease); }
  .session-filters button:hover, .session-filters button.active, .toolbar-actions button:hover:not(:disabled), .selection-actions button:hover:not(:disabled), .entry-actions button:hover, .dialog-actions button:hover:not(:disabled) { color: var(--fg); }
  .history-toolbar button:disabled, .selection-actions button:disabled, .dialog-actions button:disabled { cursor: not-allowed; opacity: .5; }
  .entry-count { color: var(--fg3); font: 10.5px var(--font-mono, "Geist Mono", ui-monospace, monospace); white-space: nowrap; }
  .text-action { color: var(--fg2) !important; }
  .quiet-toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--fg3); font: 10px var(--font-mono, "Geist Mono", ui-monospace, monospace); letter-spacing: .06em; }
  .quiet-toggle:hover, .quiet-toggle.active { color: var(--fg2); }
  .quiet-toggle:focus-visible { outline: 1px solid var(--line2); outline-offset: 3px; }
  .filter-chevron { width: 5px; height: 5px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: translateY(-1px) rotate(45deg); transition: transform .2s var(--ease); }
  .quiet-toggle.open .filter-chevron { transform: translateY(2px) rotate(225deg); }
  .filters-panel { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 18px; padding: 14px 0 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .filters-panel label { display: flex; min-width: 0; flex-direction: column; gap: 6px; color: var(--fg3); font-size: 10.5px; }
  .filters-panel input { width: 100%; min-width: 0; border: 0; border-bottom: 1px solid var(--line2); border-radius: 0; outline: 0; background: transparent; padding: 5px 0; color: var(--fg); font: 11px var(--font-mono, "Geist Mono", ui-monospace, monospace); color-scheme: dark; }
  :global(.eve-shell--light) .filters-panel input { color-scheme: light; }
  .filters-panel input:focus { border-color: var(--fg2); }
  .filters-panel input::placeholder { color: var(--fg3); }
  .clear-filters { align-self: end; justify-self: start; font-size: 11px; }
  .selection-toolbar { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0 13px; border-bottom: 1px solid var(--line); }
  .selection-copy { min-width: 0; }
  .selection-copy > p:first-child { color: var(--fg); font-size: 11.5px; }
  .selection-note { color: var(--fg3); font-size: 10.5px; }
  .feedback { margin-top: 5px; color: var(--fg2); font-size: 10.5px; }
  .selection-actions { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 12px; }
  .selection-actions button { font-size: 10.5px; }
  .delete-action { color: var(--fg2) !important; font-size: 11px; text-decoration: underline; text-underline-offset: 3px; }
  .delete-action:hover:not(:disabled) { color: var(--fg) !important; }
  .undo-list { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .undo-list p { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; color: var(--fg2); font-size: 11px; }
  .undo-list p + p { margin-top: 5px; }
  .undo-list button { flex: none; color: var(--fg); font-size: 11px; text-decoration: underline; text-underline-offset: 3px; }
  .load-error { padding: 16px 0; color: var(--fg2); font-size: 12px; }
  .load-error button { margin-top: 8px; color: var(--fg); font-size: 11px; text-decoration: underline; text-underline-offset: 3px; }
  .empty-state { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 90px 0; color: var(--fg3); font-size: 13px; text-align: center; }
  :global(.empty-cactus) { width: 30px; height: auto; color: var(--fg3); }
  :global(.empty-cactus), :global(.empty-cactus .c-armL), :global(.empty-cactus .c-armR) { animation: none; }
  .day-group { margin-top: 20px; }
  .day-header { position: sticky; z-index: 2; top: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 12px 0 9px; border-bottom: 1px solid var(--line); background: var(--bg); }
  .day-header h2 { color: var(--fg3); font-size: 10px; font-weight: 400; letter-spacing: .1em; text-transform: uppercase; }
  .day-header span { color: var(--fg3); font: 10px var(--font-mono, "Geist Mono", ui-monospace, monospace); letter-spacing: .1em; text-transform: uppercase; white-space: nowrap; }
  .entry { margin: 0 -12px; padding: 0 12px; border-bottom: 1px solid var(--line); transition: background .2s var(--ease); }
  .entry:hover, .entry.open { background: var(--hover); }
  .entry-row { display: flex; min-width: 0; align-items: center; gap: 10px; }
  .entry-check { flex: none; accent-color: var(--fg); }
  .entry-preview { display: grid; flex: 1; min-width: 0; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: baseline; gap: 14px; padding: 13px 0; color: inherit; text-align: left; }
  .entry-preview time, .entry-duration { color: var(--fg3); font: 10.5px var(--font-mono, "Geist Mono", ui-monospace, monospace); font-variant-numeric: tabular-nums; }
  .entry-text { display: -webkit-box; overflow: hidden; color: var(--fg); font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; line-clamp: 2; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .entry.open .entry-text { display: block; }
  .entry-text mark { background: var(--fg); color: var(--bg); }
  .entry-more { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .4s var(--ease); }
  .entry-more.expanded { grid-template-rows: 1fr; }
  .entry-more-inner { min-height: 0; overflow: hidden; }
  .entry-more-summary { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 12px 0 13px; border-top: 1px solid var(--line); }
  .entry-details { display: flex; min-width: 0; flex-wrap: wrap; gap: 6px 16px; color: var(--fg2); font: 10.5px var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .entry-actions { display: flex; flex: none; gap: 16px; }
  .entry-actions button { color: var(--fg2); font-size: 11px; }
  .entry-actions button:disabled { color: var(--fg3); }
  .entry-timestamp { padding-bottom: 12px; color: var(--fg3); font-size: 10px; }
  .list-end { display: flex; justify-content: center; padding: 18px 0 24px; color: var(--fg3); font-size: 10.5px; }
  .dialog-backdrop { position: fixed; z-index: 60; inset: 0; display: flex; align-items: center; justify-content: center; background: rgb(0 0 0 / .62); }
  .bulk-dialog { width: min(420px, calc(100vw - 32px)); border: 1px solid var(--line2); background: var(--bg); padding: 22px; color: var(--fg); box-shadow: 0 14px 40px rgb(0 0 0 / .25); }
  .bulk-dialog h2 { font-size: 16px; font-weight: 400; }
  .bulk-dialog > p { margin-top: 10px; color: var(--fg2); font-size: 12px; line-height: 1.6; }
  .bulk-dialog .feedback { color: var(--fg2); }
  .dialog-actions { display: flex; justify-content: flex-end; align-items: center; gap: 18px; margin-top: 20px; }
  .dialog-actions button { color: var(--fg2); font-size: 11px; }
  @media (max-width: 520px) {
    .history-view { padding-right: 0; padding-left: 0; }
    .filter-control-row { gap: 10px; }
    .session-filters { gap: 12px; }
    .toolbar-actions { gap: 14px; padding-top: 5px; }
    .entry-count { margin-right: auto; }
    .day-header { align-items: flex-start; flex-direction: column; gap: 4px; }
    .day-header h2, .day-header span { white-space: normal; }
    .filters-panel { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .selection-toolbar { align-items: flex-start; }
    .selection-actions { gap: 9px; }
    .entry { margin-right: -8px; margin-left: -8px; padding-right: 8px; padding-left: 8px; }
    .entry-preview { grid-template-columns: 38px minmax(0, 1fr) auto; gap: 8px; }
    .entry-text { font-size: 13px; }
    .entry-duration { font-size: 9.5px; }
    .day-header span { font-size: 9px; }
    .entry-more-summary { flex-wrap: wrap; align-items: flex-start; }
    .entry-details { flex-basis: 100%; }
    .entry-actions { margin-left: auto; }
  }
  @media (max-width: 340px) {
    .filter-control-row { flex-wrap: wrap; row-gap: 8px; }
    .session-filters { width: 100%; justify-content: space-between; gap: 7px; }
    .quiet-toggle { margin-left: auto; }
    .toolbar-actions { flex-wrap: wrap; row-gap: 4px; }
    .entry-count { flex: 1 1 100%; }
  }
  @media (prefers-reduced-motion: reduce) { .entry-more, .entry { transition: none; } }
</style>
