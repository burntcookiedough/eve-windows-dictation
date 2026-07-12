<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type {
    InsightsEntryStat,
    InsightsRange,
    InsightsResponse,
    InsightsTrendPoint,
    InsightsWordStat,
  } from '$shared/types';

  type TrendMetric = 'words' | 'audio' | 'processing' | 'wpm';

  const ranges: Array<{ id: InsightsRange; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: '7d', label: '7D' },
    { id: '30d', label: '30D' },
    { id: 'all', label: 'All' },
  ];

  const trendMetrics: Array<{ id: TrendMetric; label: string }> = [
    { id: 'words', label: 'Words' },
    { id: 'audio', label: 'Dictation' },
    { id: 'processing', label: 'Processing' },
    { id: 'wpm', label: 'WPM' },
  ];

  let range = $state<InsightsRange>('7d');
  let trendMetric = $state<TrendMetric>('words');
  let insights: InsightsResponse | null = $state(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);

  let peakTrendValue = $derived.by(() => {
    if (!insights) return 0;
    return Math.max(...insights.trends.map((point) => getTrendValue(point, trendMetric)), 0);
  });

  async function loadInsights() {
    loading = true;
    error = null;
    try {
      insights = await window.murmurMain.getInsights(range);
    } catch (err) {
      console.error('Failed to load insights:', err);
      error = 'Unable to load insights';
    } finally {
      loading = false;
    }
  }

  function selectRange(nextRange: InsightsRange) {
    if (range === nextRange) return;
    range = nextRange;
    loadInsights();
  }

  function formatInteger(value: number): string {
    return Math.round(value).toLocaleString();
  }

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  function formatProcessing(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return formatDuration(ms / 1000);
  }

  function formatPercent(value: number): string {
    if (value <= 0) return '0%';
    return `${Math.round(value * 100)}%`;
  }

  function formatRatio(value: number): string {
    if (value <= 0) return '0x';
    return `${value.toFixed(value >= 10 ? 0 : 1)}x`;
  }

  function formatEntryTime(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  }

  function getTrendValue(point: InsightsTrendPoint, metric: TrendMetric): number {
    switch (metric) {
      case 'words':
        return point.words;
      case 'audio':
        return point.audioSeconds / 60;
      case 'processing':
        return point.processingMs / 1000;
      case 'wpm':
        return point.avgWpm;
    }
  }

  function formatTrendValue(value: number, metric: TrendMetric): string {
    switch (metric) {
      case 'words':
        return formatInteger(value);
      case 'audio':
        return `${value.toFixed(value >= 10 ? 0 : 1)}m`;
      case 'processing':
        return `${value.toFixed(value >= 10 ? 0 : 1)}s`;
      case 'wpm':
        return formatInteger(value);
    }
  }

  function getBarGeometry(index: number, total: number) {
    const gap = total > 90 ? 1 : total > 45 ? 2 : 6;
    const availableGap = gap * Math.max(0, total - 1);
    const width = total > 0 ? Math.max(1, (520 - availableGap) / total) : 1;
    return {
      x: index * (width + gap),
      width,
    };
  }

  function barHeight(point: InsightsTrendPoint): number {
    if (!peakTrendValue) return 2;
    const value = getTrendValue(point, trendMetric);
    return Math.max((value / peakTrendValue) * 112, value > 0 ? 4 : 2);
  }

  function truncateText(text: string): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length > 88 ? `${cleaned.slice(0, 85)}...` : cleaned;
  }

  onMount(() => {
    queueMicrotask(() => scrollContainer?.scrollTo({ top: 0, behavior: 'auto' }));
    loadInsights();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadInsights();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    window.murmurMain.onNewHistoryEntry(() => {
      loadInsights();
    });

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.murmurMain.removeNewHistoryEntryListener();
    };
  });

  onDestroy(() => {
    window.murmurMain.removeNewHistoryEntryListener();
  });
</script>

<div class="h-full flex flex-col p-4 pr-2 sm:p-6 sm:pr-2">
  <div bind:this={scrollContainer} class="flex-1 overflow-y-auto pr-2 sm:pr-4">
    <div class="mx-auto w-full max-w-5xl">
    <div class="mb-5 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-zinc-100">Insights</h1>
        <p class="mt-1 text-xs text-zinc-500">Local aggregate profile from your transcription history</p>
      </div>

      <div class="flex w-full shrink-0 rounded-full border border-zinc-800 bg-zinc-900/70 p-1 sm:w-auto">
        {#each ranges as option}
          <button
            onclick={() => selectRange(option.id)}
            class="min-w-0 flex-1 px-3 py-1.5 text-xs font-medium rounded-full transition-colors cursor-pointer sm:flex-none
              {range === option.id
                ? 'bg-zinc-100 text-zinc-950'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}"
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>

    {#if error}
      <div class="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
        {error}
      </div>
    {:else if loading && !insights}
      <div class="grid grid-cols-2 gap-3">
        {#each Array(4) as _}
          <div class="h-24 rounded-lg border border-zinc-800 bg-zinc-900/40 skeleton-bone"></div>
        {/each}
      </div>
    {:else if !insights || !insights.hasData}
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-12 text-center">
        <p class="text-sm font-medium text-zinc-300">No dictations in this range</p>
        <p class="mt-1 text-xs text-zinc-500">Insights appear after history entries are saved locally.</p>
      </div>
    {:else}
      {#if insights.indexing.isIndexing}
        <div class="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          Indexing older history: {formatInteger(insights.indexing.processedEntries)} of {formatInteger(insights.indexing.totalEntries)} entries included.
        </div>
      {/if}

      <div class="grid grid-cols-2 gap-3">
        <div class="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <p class="text-xs text-zinc-500">Words spoken</p>
          <p class="mt-2 text-2xl font-semibold text-zinc-100">{formatInteger(insights.summary.totalWords)}</p>
          <p class="mt-1 text-xs text-emerald-400">{formatInteger(insights.summary.avgWordsPerDictation)} avg / dictation</p>
        </div>
        <div class="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <p class="text-xs text-zinc-500">Dictations</p>
          <p class="mt-2 text-2xl font-semibold text-zinc-100">{formatInteger(insights.summary.totalDictations)}</p>
          <p class="mt-1 text-xs text-zinc-500">
            {insights.summary.busiestDay ? `${insights.summary.busiestDay.label} busiest` : 'No active day'}
          </p>
        </div>
        <div class="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <p class="text-xs text-zinc-500">Dictation time</p>
          <p class="mt-2 text-2xl font-semibold text-zinc-100">{formatDuration(insights.summary.totalAudioSeconds)}</p>
          <p class="mt-1 text-xs text-amber-400">{formatInteger(insights.summary.avgWpm)} WPM</p>
        </div>
        <div class="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <p class="text-xs text-zinc-500">Processing</p>
          <p class="mt-2 text-2xl font-semibold text-zinc-100">{formatProcessing(insights.summary.totalProcessingMs)}</p>
          <p class="mt-1 text-xs text-emerald-400">{formatRatio(insights.summary.avgProcessingRatio)} realtime</p>
        </div>
      </div>

      <div class="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div class="mb-4 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div class="min-w-0">
            <h2 class="text-sm font-medium text-zinc-200">Trends</h2>
            <p class="mt-1 text-xs text-zinc-500">
              Confidence {formatPercent(insights.summary.avgConfidence)}
              <span class="mx-1 text-zinc-700">/</span>
              {insights.summary.longestStreakDays} day streak
            </p>
          </div>
          <div class="grid w-full grid-cols-4 rounded-lg bg-zinc-950/60 p-1 sm:w-auto">
            {#each trendMetrics as metric}
              <button
                onclick={() => (trendMetric = metric.id)}
                class="px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer
                  {trendMetric === metric.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'}"
              >
                {metric.label}
              </button>
            {/each}
          </div>
        </div>

        <div class="mx-auto h-44 w-full max-w-3xl overflow-hidden">
          <svg viewBox="0 0 520 176" preserveAspectRatio="none" class="h-full w-full">
            <line x1="0" y1="137" x2="520" y2="137" stroke="rgb(63 63 70 / 0.6)" stroke-width="1" />
            {#each insights.trends as point, index}
              {@const geometry = getBarGeometry(index, insights.trends.length)}
              {@const height = barHeight(point)}
              {@const y = 137 - height}
              {@const value = getTrendValue(point, trendMetric)}
              <rect
                x={geometry.x}
                y={y}
                width={geometry.width}
                height={height}
                rx="3"
                class="{value > 0 ? 'fill-emerald-500/75' : 'fill-zinc-800'}"
              />
              {#if insights.trends.length <= 14 || index % Math.ceil(insights.trends.length / 8) === 0}
                <text x={geometry.x + geometry.width / 2} y="160" text-anchor="middle" class="fill-zinc-500 text-[10px]">
                  {point.label}
                </text>
              {/if}
            {/each}
            {#if peakTrendValue > 0}
              <text x="0" y="12" class="fill-zinc-500 text-[10px]">
                {formatTrendValue(peakTrendValue, trendMetric)}
              </text>
            {/if}
          </svg>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-1 gap-4">
        <section class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <h2 class="text-sm font-medium text-zinc-200">Speaking Profile</h2>
          <div class="mt-4 space-y-4">
            {@render WordCloud('Common words', insights.commonWords)}
            {@render WordCloud('Common phrases', insights.commonPhrases)}
          </div>
        </section>

        <section class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <h2 class="text-sm font-medium text-zinc-200">Quality & Performance</h2>
          <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div class="rounded-lg bg-zinc-950/50 px-3 py-3">
              <p class="text-xs text-zinc-500">Confidence</p>
              <p class="mt-1 text-lg font-medium text-zinc-100">{formatPercent(insights.summary.avgConfidence)}</p>
            </div>
            <div class="rounded-lg bg-zinc-950/50 px-3 py-3">
              <p class="text-xs text-zinc-500">Realtime</p>
              <p class="mt-1 text-lg font-medium text-emerald-400">{formatRatio(insights.summary.avgProcessingRatio)}</p>
            </div>
            <div class="rounded-lg bg-zinc-950/50 px-3 py-3">
              <p class="text-xs text-zinc-500">Streak</p>
              <p class="mt-1 text-lg font-medium text-amber-400">{insights.summary.longestStreakDays}d</p>
            </div>
          </div>
        </section>

        {@render EntryList(
          'Longest Dictations',
          insights.longestEntries,
          (entry) => formatDuration(entry.audioDuration),
          formatEntryTime,
          truncateText
        )}

        {@render EntryList(
          'Slowest Processing',
          insights.slowestEntries,
          (entry) => formatRatio(entry.processingRatio),
          formatEntryTime,
          truncateText
        )}
      </div>
    {/if}
    </div>
  </div>
</div>

{#snippet WordCloud(title: string, words: InsightsWordStat[])}
  <div>
    <div class="mb-2 flex items-center justify-between">
      <p class="text-xs text-zinc-500">{title}</p>
      {#if words.length > 0}
        <span class="text-[11px] text-zinc-600">{words.length}</span>
      {/if}
    </div>
    {#if words.length === 0}
      <p class="text-xs text-zinc-600">No patterns yet</p>
    {:else}
      <div class="flex flex-wrap gap-2">
        {#each words as word}
          <span class="rounded-full border border-zinc-800 bg-zinc-950/70 px-2.5 py-1 text-xs text-zinc-300">
            {word.text}
            <span class="ml-1 text-emerald-400/80">{word.count}</span>
          </span>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet EntryList(
  title: string,
  entries: InsightsEntryStat[],
  metric: (entry: InsightsEntryStat) => string,
  formatEntryTime: (timestamp: number) => string,
  truncateText: (text: string) => string
)}
  <section class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
    <h2 class="text-sm font-medium text-zinc-200">{title}</h2>
    {#if entries.length === 0}
      <p class="mt-3 text-xs text-zinc-600">No entries in this range</p>
    {:else}
      <div class="mt-3 divide-y divide-zinc-800/80">
        {#each entries as entry}
          <div class="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
            <div class="min-w-0 flex-1">
              <p class="line-clamp-2 text-sm text-zinc-300">{truncateText(entry.text)}</p>
              <p class="mt-1 text-xs text-zinc-600">
                {formatEntryTime(entry.timestamp)}
                <span class="mx-1 text-zinc-700">/</span>
                {entry.wordCount} words
              </p>
            </div>
            <span class="shrink-0 rounded-md bg-zinc-950/70 px-2 py-1 text-xs font-medium text-amber-300">
              {metric(entry)}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/snippet}
