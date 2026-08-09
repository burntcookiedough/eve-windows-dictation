<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    InsightsEntryStat,
    InsightsRange,
    InsightsResponse,
    InsightsTrendPoint,
    InsightsWordStat,
  } from '$shared/types';
  import { createLatestRequestGuard } from '../latest-request';
  import PrimaryPage from '../components/PrimaryPage.svelte';
  import EveDropdown from '../components/EveDropdown.svelte';

  const ranges: Array<{ id: InsightsRange; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: '7d', label: '7D' },
    { id: '30d', label: '30D' },
    { id: 'all', label: 'All' },
  ];

  let range = $state<InsightsRange>('7d');
  let insights: InsightsResponse | null = $state(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);
  const insightRequests = createLatestRequestGuard();

  async function loadInsights() {
    const requestId = insightRequests.begin();
    loading = true;
    error = null;
    try {
      const response = await window.murmurMain.getInsights(range);
      if (insightRequests.isCurrent(requestId)) {
        insights = response;
      }
    } catch (err) {
      if (!insightRequests.isCurrent(requestId)) return;
      console.error('Failed to load insights:', err);
      error = 'Unable to load insights';
    } finally {
      if (insightRequests.isCurrent(requestId)) {
        loading = false;
      }
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

  function truncateText(text: string): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length > 88 ? `${cleaned.slice(0, 85)}...` : cleaned;
  }

  onMount(() => {
    scrollContainer = document.querySelector<HTMLDivElement>('[data-scroll-owner="insights"]') ?? undefined;
    queueMicrotask(() => scrollContainer?.scrollTo({ top: 0, behavior: 'auto' }));
    loadInsights();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadInsights();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const unsubscribeNewHistoryEntry = window.murmurMain.onNewHistoryEntry(() => {
      loadInsights();
    });

    return () => {
      insightRequests.invalidate();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubscribeNewHistoryEntry();
    };
  });
</script>

<PrimaryPage page="insights" scrollOwner="insights" contentClass="pb-4">
  <div class="mx-auto flex min-h-full w-full max-w-[560px] flex-col pr-3">
    <div class="mb-4 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="sr-only">Insights</h1>
        <p class="text-[11px] text-zinc-500">Local insights from your transcription history</p>
      </div>

      <EveDropdown
        label="Insights time range"
        value={range}
        options={ranges.map((option) => ({ value: option.id, label: option.label }))}
        onchange={(value) => selectRange(value as InsightsRange)}
      />
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
        <div class="mb-4 rounded-lg border border-white/15 bg-white/[0.06] px-4 py-3 text-xs text-zinc-200" role="status">
          Indexing older history: {formatInteger(insights.indexing.processedEntries)} of {formatInteger(insights.indexing.totalEntries)} entries included.
        </div>
      {/if}

      <div class="grid grid-cols-1 gap-2.5">
        <section class="flex min-h-[106px] items-center justify-between rounded-[9px] border border-white/10 bg-white/[0.025] px-3 py-3" aria-labelledby="dictation-time-heading">
          <div>
            <h2 id="dictation-time-heading" class="text-xs text-zinc-400">Dictation time</h2>
            <p class="mt-1.5 text-[22px] font-medium leading-none text-zinc-100">{formatDuration(insights.summary.totalAudioSeconds)}</p>
            <p class="mt-2 text-[11px] text-zinc-500">Total dictation time</p>
          </div>
          {@render MiniBars(insights.trends, 'audioSeconds')}
        </section>
        <section class="flex min-h-[106px] items-center justify-between rounded-[9px] border border-white/10 bg-white/[0.025] px-3 py-3" aria-labelledby="dictations-heading">
          <div>
            <h2 id="dictations-heading" class="text-xs text-zinc-400">Dictations</h2>
            <p class="mt-1.5 text-[22px] font-medium leading-none text-zinc-100">{formatInteger(insights.summary.totalDictations)}</p>
            <p class="mt-2 text-[11px] text-zinc-500">Total dictations</p>
          </div>
          <div class="grid w-40 grid-cols-8 gap-1.5" role="img" aria-label="{formatInteger(insights.summary.totalDictations)} total dictations">
            {#each Array(48) as _, index}
              <span class="h-2 w-2 rounded-full {index < Math.min(insights.summary.totalDictations, 48) ? 'bg-zinc-300/75' : 'bg-zinc-700/45'}"></span>
            {/each}
          </div>
        </section>
        <section class="flex min-h-[106px] items-center justify-between rounded-[9px] border border-white/10 bg-white/[0.025] px-3 py-3" aria-labelledby="average-length-heading">
          <div>
            <h2 id="average-length-heading" class="text-xs text-zinc-400">Average dictation length</h2>
            <p class="mt-1.5 text-[22px] font-medium leading-none text-zinc-100">
              {formatDuration(insights.summary.totalDictations > 0 ? insights.summary.totalAudioSeconds / insights.summary.totalDictations : 0)}
            </p>
            <p class="mt-2 text-[11px] text-zinc-500">Per dictation</p>
          </div>
          {@render MiniLine(insights.trends)}
        </section>

        <section class="overflow-hidden rounded-[9px] border border-white/10 bg-white/[0.025]" aria-labelledby="day-table-heading">
          <h2 id="day-table-heading" class="border-b border-white/[0.08] px-3 py-2.5 text-xs text-zinc-300">Dictation time by day</h2>
          <table class="w-full text-left text-[11px]">
            <thead class="text-zinc-500">
              <tr><th class="px-3 py-2 font-normal">Day</th><th class="px-3 py-2 font-normal">Time</th><th class="px-3 py-2 font-normal"><span class="sr-only">Relative duration</span></th></tr>
            </thead>
            <tbody class="divide-y divide-white/[0.07] text-zinc-300">
              {#each insights.trends.slice(-7) as point}
                <tr>
                  <th scope="row" class="px-3 py-2 font-normal">{point.label}</th>
                  <td class="px-3 py-2 tabular-nums">{formatDuration(point.audioSeconds)}</td>
                  <td class="w-1/2 px-3 py-2">
                    <span class="block h-1 rounded-full bg-zinc-300/70" style:width={`${Math.max(4, (point.audioSeconds / Math.max(...insights.trends.map((trend) => trend.audioSeconds), 1)) * 100)}%`}></span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
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
              <p class="text-xs text-zinc-400">Realtime</p>
              <p class="mt-1 text-lg font-medium text-zinc-100">{formatRatio(insights.summary.avgProcessingRatio)}</p>
            </div>
            <div class="rounded-lg bg-zinc-950/50 px-3 py-3">
              <p class="text-xs text-zinc-400">Streak</p>
              <p class="mt-1 text-lg font-medium text-zinc-100">{insights.summary.longestStreakDays}d</p>
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
</PrimaryPage>

{#snippet MiniBars(points: InsightsTrendPoint[], metric: 'dictations' | 'words' | 'audioSeconds' | 'processingMs')}
  {@const peak = Math.max(...points.map((point) => point[metric]), 1)}
  <svg
    viewBox="0 0 160 52"
    class="h-[52px] w-40 shrink-0"
    role="img"
    aria-label="Recent {metric === 'audioSeconds' ? 'dictation time' : metric} trend"
  >
    <line x1="0" y1="49" x2="160" y2="49" stroke="rgb(113 113 122 / 0.35)" stroke-width="1" />
    {#each points.slice(-7) as point, index}
      {@const height = Math.max(3, (point[metric] / peak) * 42)}
      <rect
        x={index * 22 + 3}
        y={49 - height}
        width="12"
        height={height}
        rx="2"
        class="fill-zinc-300/80"
      >
        <title>{point.label}: {point[metric]}</title>
      </rect>
    {/each}
  </svg>
{/snippet}

{#snippet MiniLine(points: InsightsTrendPoint[])}
  {@const recent = points.slice(-7)}
  {@const averages = recent.map((point) => point.dictations > 0 ? point.audioSeconds / point.dictations : 0)}
  {@const peak = Math.max(...averages, 1)}
  {@const coordinates = averages.map((average, index) => `${index * 25 + 5},${48 - (average / peak) * 38}`).join(' ')}
  <svg viewBox="0 0 160 52" class="h-[52px] w-40 shrink-0" role="img" aria-label="Average dictation length trend">
    <polyline
      points={coordinates}
      fill="none"
      stroke="rgb(212 212 216 / 0.9)"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    {#each recent as point, index}
      <circle cx={index * 25 + 5} cy={48 - (averages[index] / peak) * 38} r="2" class="fill-zinc-200">
        <title>{point.label}: {formatDuration(averages[index])} average</title>
      </circle>
    {/each}
  </svg>
{/snippet}

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
            <span class="ml-1 text-zinc-100">{word.count}</span>
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
            <span class="shrink-0 rounded-md bg-zinc-950/70 px-2 py-1 text-xs font-medium text-zinc-100">
              {metric(entry)}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/snippet}
