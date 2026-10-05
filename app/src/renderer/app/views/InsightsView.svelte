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
  import { buildDictationTimeChart, buildWordsAreaChart, formatInsightsDuration } from '../insights-chart';
  import type { DictationTimeChart, WordsAreaChart } from '../insights-chart';

  const primaryRanges: Array<{ id: InsightsRange; label: string }> = [
    { id: '7d', label: '7d' },
    { id: '30d', label: '30d' },
    { id: '90d', label: '90d' },
    { id: '1y', label: '1y' },
  ];
  const quietRanges: Array<{ id: InsightsRange; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: 'all', label: 'All time' },
  ];

  let range = $state<InsightsRange>('30d');
  let insights = $state<InsightsResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let showQuietRanges = $state(false);
  let chartHost: HTMLElement | undefined = $state(undefined);
  let chartWidth = $state(720);
  let chartClipWidth = $state(0);
  let hoveredIndex = $state<number | null>(null);
  let indexingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const insightRequests = createLatestRequestGuard();

  let selectedRangeLabel = $derived([...primaryRanges, ...quietRanges].find((option) => option.id === range)?.label ?? range);
  let wordChart: WordsAreaChart = $derived(buildWordsAreaChart(insights?.trends ?? [], chartWidth, 160));
  let dailyChart: DictationTimeChart = $derived(buildDictationTimeChart(insights?.trends ?? []));
  let hoveredPoint = $derived(hoveredIndex === null ? null : wordChart.points[hoveredIndex] ?? null);
  let heatmap = $derived(buildHeatmap(insights?.yearActivity));
  let hours = $derived(buildHourBars(insights?.hourlyDictations));
  let activeDays = $derived((insights?.trends ?? []).filter((point) => finiteNonNegative(point.words) > 0).length);
  let currentWords = $derived(finiteNonNegative(insights?.summary.totalWords ?? 0));
  let previousWords = $derived(
    !insights?.indexing.isIndexing && typeof insights?.previousPeriodWords === 'number'
      ? finiteNonNegative(insights.previousPeriodWords)
      : null,
  );
  let comparison = $derived(formatComparison(currentWords, previousWords, range));
  let savedVersusTyping = $derived(
    insights?.hasData ? formatTypingDifference(currentWords, finiteNonNegative(insights.summary.totalAudioSeconds)) : null,
  );

  function clearIndexingRefresh(): void {
    if (indexingRefreshTimer !== null) {
      clearTimeout(indexingRefreshTimer);
      indexingRefreshTimer = null;
    }
  }

  async function loadInsights() {
    clearIndexingRefresh();
    const requestId = insightRequests.begin();
    loading = true;
    error = null;
    try {
      const response = await window.murmurMain.getInsights(range);
      if (insightRequests.isCurrent(requestId)) {
        insights = response;
        hoveredIndex = null;
        if (response?.indexing.isIndexing) {
          indexingRefreshTimer = setTimeout(() => {
            indexingRefreshTimer = null;
            if (insightRequests.isCurrent(requestId) && insights?.indexing.isIndexing) void loadInsights();
          }, 1000);
        }
      }
    } catch (err) {
      if (!insightRequests.isCurrent(requestId)) return;
      console.error('Failed to load insights:', err);
      error = 'Unable to load insights';
    } finally {
      if (insightRequests.isCurrent(requestId)) loading = false;
    }
  }

  function selectRange(nextRange: InsightsRange) {
    if (range === nextRange) return;
    range = nextRange;
    hoveredIndex = null;
    loadInsights();
  }

  function handleChartPointerMove(event: PointerEvent) {
    const host = chartHost;
    if (!host || wordChart.points.length === 0) return;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pointerX = ((event.clientX - rect.left) / rect.width) * wordChart.width;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < wordChart.points.length; index += 1) {
      const point = wordChart.points[index];
      if (!point) continue;
      const distance = Math.abs(point.x - pointerX);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    }
    hoveredIndex = closestIndex;
  }

  function handleChartKeydown(event: KeyboardEvent) {
    if (wordChart.points.length === 0) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const current = hoveredIndex ?? 0;
    hoveredIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? wordChart.points.length - 1
        : Math.max(0, Math.min(wordChart.points.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)));
  }

  function formatInteger(value: number): string {
    return Math.round(finiteNonNegative(value)).toLocaleString();
  }

  function formatDuration(seconds: number): string {
    return formatInsightsDuration(seconds);
  }

  function formatPercent(value: number): string {
    const bounded = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    return `${Math.round(bounded * 100)}%`;
  }

  function formatEntryDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatEntryWpm(entry: InsightsEntryStat): number {
    const seconds = finiteNonNegative(entry.audioDuration);
    return seconds > 0 ? Math.round((finiteNonNegative(entry.wordCount) / seconds) * 60) : 0;
  }

  function finiteNonNegative(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  onMount(() => {
    queueMicrotask(() => document.querySelector<HTMLDivElement>('[data-scroll-owner="insights"]')?.scrollTo({ top: 0, behavior: 'auto' }));
    loadInsights();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadInsights();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const unsubscribeNewHistoryEntry = window.murmurMain.onNewHistoryEntry(() => loadInsights());
    const handleHistoryDelete = (event: Event) => {
      const detail = (event as CustomEvent<{ ids: string[]; deleted: boolean }>).detail;
      if (detail?.deleted && detail.ids.length > 0) loadInsights();
    };
    window.addEventListener('history-delete-committed', handleHistoryDelete);

    return () => {
      insightRequests.invalidate();
      clearIndexingRefresh();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubscribeNewHistoryEntry();
      window.removeEventListener('history-delete-committed', handleHistoryDelete);
    };
  });

  $effect(() => {
    const host = chartHost;
    if (!host) return;

    const measureWidth = () => {
      const width = host.getBoundingClientRect().width;
      if (Number.isFinite(width) && width > 0) chartWidth = Math.max(1, Math.floor(width));
    };
    measureWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureWidth);
      return () => window.removeEventListener('resize', measureWidth);
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries.find((entry) => entry.target === host)?.contentRect.width;
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) chartWidth = Math.max(1, Math.floor(width));
    });
    resizeObserver.observe(host);
    return () => resizeObserver.disconnect();
  });

  $effect(() => {
    const width = wordChart.width;
    chartClipWidth = 0;
    const frame = requestAnimationFrame(() => { chartClipWidth = width; });
    return () => cancelAnimationFrame(frame);
  });

  function formatRatio(value: number): string {
    const safeValue = finiteNonNegative(value);
    return safeValue <= 0 ? '0x' : `${safeValue.toFixed(safeValue >= 10 ? 0 : 1)}x`;
  }

  function rangeDays(value: InsightsRange): string {
    if (value === 'today') return '1';
    if (value === '7d') return '7';
    if (value === '30d') return '30';
    if (value === '90d') return '90';
    if (value === '1y') return '365';
    return 'all';
  }

  function formatComparison(current: number, previous: number | null, value: InsightsRange): string | null {
    if (previous === null || previous <= 0 || value === 'all') return null;
    const change = ((current - previous) / previous) * 100;
    if (!Number.isFinite(change)) return null;
    const direction = change > 0 ? '↑' : change < 0 ? '↓' : '—';
    const label = value === 'today' ? 'previous day' : `previous ${rangeDays(value)} days`;
    return `${direction} ${Math.abs(Math.round(change))}% vs ${label}`;
  }

  function formatTypingDifference(words: number, secondsSpoken: number): string {
    const differenceMinutes = words / 40 - secondsSpoken / 60;
    const magnitude = formatInsightsDuration(Math.abs(differenceMinutes) * 60);
    if (differenceMinutes > 0) return `≈ ${magnitude} saved vs typing`;
    if (differenceMinutes < 0) return `≈ ${magnitude} more spoken than typing`;
    return '≈ 0s saved vs typing';
  }

  function buildHeatmap(activity: InsightsResponse['yearActivity']) {
    if (!activity) return null;
    const end = activity.at(-1)?.date ?? currentDateKey();
    const lastOrdinal = dateOrdinal(end);
    if (lastOrdinal === null) return null;
    const start = startOfYearActivity(end);
    const byDate = new Map(activity.map((item) => [item.date, item]));

    const weeks: Array<Array<{ date: string; words: number; future: boolean }>> = [];
    let activeDays = 0;
    let totalWords = 0;
    for (let weekIndex = 0; weekIndex < 53; weekIndex += 1) {
      const week: Array<{ date: string; words: number; future: boolean }> = [];
      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        const offset = weekIndex * 7 + dayIndex;
        const date = addDateKeyDays(start, offset);
        const ordinal = dateOrdinal(date);
        const future = ordinal === null || ordinal > lastOrdinal;
        const row = byDate.get(date);
        const words = finiteNonNegative(row?.words ?? 0);
        if (!future && words > 0) {
          activeDays += 1;
          totalWords += words;
        }
        week.push({ date, words, future });
      }
      weeks.push(week);
    }

    const months: Array<{ week: number; label: string }> = [];
    let previousMonth = -1;
    for (let week = 0; week < weeks.length; week += 1) {
      const cell = weeks[week]?.[0];
      if (!cell || cell.future) continue;
      const date = parseDateKey(cell.date);
      if (!date) continue;
      if (date.getMonth() !== previousMonth && date.getDate() <= 7 && week < 52) {
        months.push({ week, label: date.toLocaleDateString('en-US', { month: 'short' }) });
      }
      previousMonth = date.getMonth();
    }
    return { weeks, months, activeDays, totalWords };
  }

  function heatLevelOpacity(words: number): number {
    if (words <= 0) return 0.07;
    if (words < 150) return 0.24;
    if (words < 300) return 0.45;
    if (words < 500) return 0.7;
    return 0.95;
  }

  function buildHourBars(values: number[] | undefined) {
    if (!values || values.length !== 24) return null;
    const counts = values.map((value) => finiteNonNegative(value));
    const peakCount = Math.max(...counts);
    return { counts, peakCount, peakHour: counts.indexOf(peakCount) };
  }

  function formatHour(hour: number): string {
    const boundedHour = ((Math.floor(hour) % 24) + 24) % 24;
    const suffix = boundedHour < 12 ? 'a' : 'p';
    return `${boundedHour % 12 || 12}${suffix}`;
  }

  function commonWordWidth(word: InsightsWordStat, words: InsightsWordStat[]): number {
    const highest = Math.max(1, ...words.map((item) => finiteNonNegative(item.count)));
    return Math.max(1, Math.min(100, (finiteNonNegative(word.count) / highest) * 100));
  }

  function formatDay(dateKey: string): string {
    const date = parseDateKey(dateKey);
    return date?.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) ?? dateKey;
  }

  function parseDateKey(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  function currentDateKey(): string {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function startOfYearActivity(endKey: string): string {
    const end = parseDateKey(endKey);
    if (!end) return endKey;
    end.setDate(end.getDate() - (52 * 7));
    end.setDate(end.getDate() - ((end.getDay() + 6) % 7));
    return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
  }

  function addDateKeyDays(value: string, offset: number): string {
    const ordinal = dateOrdinal(value);
    if (ordinal === null) return value;
    const date = new Date((ordinal + offset) * 86400000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function dateOrdinal(value: string): number | null {
    const date = parseDateKey(value);
    if (!date) return null;
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
  }

  function formatStatCount(value: number): string {
    return Math.round(finiteNonNegative(value)).toLocaleString();
  }
</script>

<PrimaryPage page="insights" scrollOwner="insights" contentClass="pb-4">
  <main class="insights-view">
    <header class="page-head" data-r style:--r={0}>
      <h1>Insights</h1>
      <div class="range-controls" aria-label="Insights time range">
        <div class="range-tabs" role="group" aria-label="Primary time ranges">
          {#each primaryRanges as option (option.id)}
            <button class:active={range === option.id} aria-pressed={range === option.id} onclick={() => selectRange(option.id)}>{option.label}</button>
          {/each}
        </div>
        <button class="quiet-toggle" aria-expanded={showQuietRanges} onclick={() => showQuietRanges = !showQuietRanges}>
          {showQuietRanges ? 'less' : 'more'}
        </button>
        {#if showQuietRanges}
          <div class="quiet-ranges" role="group" aria-label="Additional time ranges">
            {#each quietRanges as option (option.id)}
              <button class:active={range === option.id} aria-pressed={range === option.id} onclick={() => selectRange(option.id)}>{option.label}</button>
            {/each}
          </div>
        {/if}
      </div>
    </header>

    {#if error && !insights}
      <p class="state-message" role="alert">{error}</p>
    {:else if !insights && loading}
      <p class="state-message" role="status">Loading insights…</p>
    {:else if !insights}
      <p class="state-message" role="status">{error ?? 'Insights are not available.'}</p>
    {:else}
      {#if insights.indexing.isIndexing}
        <p class="indexing-message" role="status">
          Indexing older history: {formatInteger(insights.indexing.processedEntries)} of {formatInteger(insights.indexing.totalEntries)} entries included.
        </p>
      {/if}

      {#if !insights.hasData}
        <p class="empty-period" role="status">No dictations in {range === 'today' ? 'today' : range === 'all' ? 'all time' : `the last ${selectedRangeLabel}`}.</p>
      {/if}

      <section class="hero" aria-labelledby="words-heading" data-r style:--r={1}>
        <p id="words-heading" class="section-label">Words dictated</p>
        <p class="hero-number">{formatInteger(currentWords)}</p>
        <div class="hero-sub">
          {#if comparison}<span>{comparison}</span>{/if}
          {#if savedVersusTyping}<span>{savedVersusTyping}</span>{/if}
          {#if loading}<span class="loading-note" role="status">Updating</span>{/if}
        </div>
      </section>

      <section class="chart" bind:this={chartHost} data-insights-word-chart aria-label="Words dictated by day" data-r style:--r={2}>
        {#if wordChart.points.length === 0}
          <div class="chart-empty">No daily word totals</div>
        {:else}
          <div
            class="chart-interaction"
            role="slider"
            aria-label={`Daily words for ${selectedRangeLabel}`}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, wordChart.points.length - 1)}
            aria-valuenow={hoveredIndex ?? 0}
            aria-valuetext={hoveredPoint ? `${hoveredPoint.label}: ${formatInteger(hoveredPoint.words)} words` : 'Choose a day'}
            tabindex="0"
            onpointermove={handleChartPointerMove}
            onpointerleave={() => hoveredIndex = null}
            onkeydown={handleChartKeydown}
          >
          <svg
            viewBox={`0 0 ${wordChart.width} ${wordChart.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="insights-word-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="currentColor" stop-opacity=".12" />
                <stop offset="1" stop-color="currentColor" stop-opacity="0" />
              </linearGradient>
              <clipPath id="insights-word-clip">
                <rect x="0" y="0" width={Math.max(0, Math.min(wordChart.width, chartClipWidth))} height={wordChart.height} />
              </clipPath>
            </defs>
            {#each wordChart.ticks.slice(0, 3) as tick (tick.valueWords)}
              <line class="chart-grid" x1="0" x2={wordChart.width} y1={tick.y} y2={tick.y} />
            {/each}
            <line class="chart-baseline" x1="0" x2={wordChart.width} y1={wordChart.plotBottom} y2={wordChart.plotBottom} />
            <g clip-path="url(#insights-word-clip)">
              {#if wordChart.areaPath}
                <path class="chart-area" d={wordChart.areaPath} />
                <path class="chart-line" d={wordChart.linePath} />
              {/if}
            </g>
            {#if wordChart.xAxisEndLabel}
              <text class="chart-x-label" x={wordChart.plotLeft} y={wordChart.height - 4} text-anchor="start">{wordChart.xAxisStartLabel}</text>
              <text class="chart-x-label" x={wordChart.plotRight} y={wordChart.height - 4} text-anchor="end">{wordChart.xAxisEndLabel}</text>
            {:else}
              <text class="chart-x-label" x={wordChart.width / 2} y={wordChart.height - 4} text-anchor="middle">{wordChart.xAxisStartLabel}</text>
            {/if}
            {#if hoveredPoint}
              <line class="chart-crosshair" x1={hoveredPoint.x} x2={hoveredPoint.x} y1={wordChart.plotTop} y2={wordChart.plotBottom} />
              <circle class="chart-point" cx={hoveredPoint.x} cy={hoveredPoint.y} r="3" />
            {/if}
            <rect class="chart-hit-area" x="0" y="0" width={Math.max(0, wordChart.width)} height={Math.max(0, wordChart.height)} />
          </svg>
          </div>
          {#if hoveredPoint}
            {@const tooltipLeft = Math.max(10, Math.min(90, (hoveredPoint.x / Math.max(1, wordChart.width)) * 100))}
            <p class="chart-tooltip" style:left="{tooltipLeft}%">{hoveredPoint.label}<span>{formatInteger(hoveredPoint.words)} words</span></p>
          {/if}
        {/if}
      </section>

      <section class="metrics" aria-label="Period metrics" data-r style:--r={3}>
        <div class="metric"><p class="section-label">Time spoken</p><p class="metric-value">{formatDuration(insights.summary.totalAudioSeconds)}</p></div>
        <div class="metric"><p class="section-label">Dictations</p><p class="metric-value">{formatInteger(insights.summary.totalDictations)}</p></div>
        <div class="metric"><p class="section-label">Pace</p><p class="metric-value">{#if insights.hasData}{formatInteger(insights.summary.avgWpm)}<small>wpm</small>{:else}—{/if}</p></div>
        <div class="metric"><p class="section-label">Avg length</p><p class="metric-value">{#if insights.summary.totalDictations > 0}{formatInteger(insights.summary.avgWordsPerDictation)}<small>words</small>{:else}—{/if}</p></div>
        <div class="metric"><p class="section-label">Confidence</p><p class="metric-value">{insights.summary.totalDictations > 0 ? formatPercent(insights.summary.avgConfidence) : '—'}</p></div>
        <div class="metric"><p class="section-label">Active days</p><p class="metric-value">{formatInteger(activeDays)}<small>{range === 'all' ? 'days' : `/ ${rangeDays(range)}`}</small></p></div>
      </section>

      {#if heatmap}
        <section class="section" aria-labelledby="activity-heading" data-r style:--r={4}>
          <div class="section-head"><h2 id="activity-heading">Activity</h2><span>{formatInteger(heatmap.activeDays)} active days · {formatInteger(heatmap.totalWords)} words this year</span></div>
          <div class="heatmap" aria-label="Daily word activity over the past year">
            <div class="heat-months" aria-hidden="true">
              {#each heatmap.months as month (`${month.week}-${month.label}`)}
                <span style:grid-column="{month.week + 1}">{month.label}</span>
              {/each}
            </div>
            <div class="heat-grid" role="img" aria-label={`${formatInteger(heatmap.activeDays)} active days in the past year`}>
              {#each heatmap.weeks as week, weekIndex (week[0]?.date ?? weekIndex)}
                {#each week as cell, dayIndex (cell.date)}
                  <i
                    class:future={cell.future}
                    style:--cell-opacity={cell.future ? 0 : heatLevelOpacity(cell.words)}
                    style:--column={weekIndex}
                    style:--row={dayIndex}
                    title={cell.future ? undefined : `${cell.words ? `${formatInteger(cell.words)} words` : 'No dictation'} · ${formatDay(cell.date)}`}
                    aria-hidden="true"
                  ></i>
                {/each}
              {/each}
            </div>
          </div>
          <div class="legend" aria-label="Less activity to more activity"><span>less</span><i style:opacity=".07"></i><i style:opacity=".24"></i><i style:opacity=".45"></i><i style:opacity=".7"></i><i style:opacity=".95"></i><span>more</span></div>
        </section>
      {/if}

      {#if hours}
        <section class="section" aria-labelledby="rhythm-heading" data-r style:--r={5}>
          <div class="section-head"><h2 id="rhythm-heading">Rhythm</h2>{#if hours.peakCount > 0}<span>most active {formatHour(hours.peakHour)}–{formatHour((hours.peakHour + 1) % 24)}</span>{/if}</div>
          <div class="hour-bars" role="img" aria-label="Dictations by hour of day">
            {#each hours.counts as count, hour (hour)}
              <i class:peak={count > 0 && hour === hours.peakHour} style:height="{count > 0 ? Math.max(1.5, (count / Math.max(1, hours.peakCount)) * 100) : 0}%" title={`${formatHour(hour)}: ${formatInteger(count)} dictations`}></i>
            {/each}
          </div>
          <div class="hour-labels"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div>
        </section>
      {/if}

      {#if insights.commonWords.length > 0}
        <section class="section" aria-labelledby="words-used-heading" data-r style:--r={6}>
          <div class="section-head"><h2 id="words-used-heading">Words you reach for</h2></div>
          <div class="common-words">
            {#each insights.commonWords as word (word.text)}
              <div class="common-word">
                <span class="common-word-text">{word.text}</span>
                <span class="common-word-rule"><i style:width="{commonWordWidth(word, insights.commonWords)}%"></i></span>
                <span class="common-word-count">{formatInteger(word.count)}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if insights.longestEntries.length > 0 || insights.fastestEntry || insights.summary.busiestDay || insights.summary.longestStreakDays > 0}
        <section class="section records" aria-labelledby="records-heading" data-r style:--r={7}>
          <div class="section-head"><h2 id="records-heading">Records</h2></div>
          {#if insights.longestEntries[0]}
            {@const longest = insights.longestEntries[0]}
            <div class="record"><p class="section-label">Longest dictation</p><div><p class="record-value">{formatDuration(longest.audioDuration)} · {formatInteger(longest.wordCount)} words</p><p class="record-sub">{formatEntryDate(longest.timestamp)}</p></div></div>
          {/if}
          {#if insights.fastestEntry}
            <div class="record"><p class="section-label">Fastest</p><div><p class="record-value">{formatInteger(formatEntryWpm(insights.fastestEntry))} wpm · {formatInteger(insights.fastestEntry.wordCount)} words</p><p class="record-sub">{formatEntryDate(insights.fastestEntry.timestamp)}</p></div></div>
          {/if}
          {#if insights.summary.busiestDay}
            <div class="record"><p class="section-label">Best day</p><div><p class="record-value">{formatInteger(insights.summary.busiestDay.words)} words</p><p class="record-sub">{insights.summary.busiestDay.label}</p></div></div>
          {/if}
          {#if insights.summary.longestStreakDays > 0}
            <div class="record"><p class="section-label">Longest streak</p><p class="record-value">{formatInteger(insights.summary.longestStreakDays)} days</p></div>
          {/if}
        </section>
      {/if}

      <details class="more-insights">
        <summary>More insights</summary>
        <div class="more-content">
          <section data-insights-dictation-time-chart aria-labelledby="dictation-time-heading">
            <div class="section-head"><h2 id="dictation-time-heading">Daily dictation time</h2><span>{dailyChart.unitLabel} · {selectedRangeLabel}</span></div>
            {@render DailyDictationChart(dailyChart, selectedRangeLabel, formatDuration, formatInteger)}
          </section>

          {#if insights.commonPhrases.length > 0}
            <section class="advanced-section" aria-labelledby="phrases-heading">
              <div class="section-head"><h2 id="phrases-heading">Common phrases</h2></div>
              {@render WordList(insights.commonPhrases)}
            </section>
          {/if}

          <section class="advanced-section" aria-labelledby="processing-heading">
            <div class="section-head"><h2 id="processing-heading">Processing</h2></div>
            <div class="record"><p class="section-label">Average ratio</p><p class="record-value">{insights.summary.totalDictations > 0 ? formatRatio(insights.summary.avgProcessingRatio) : '—'}</p></div>
          </section>

          {#if insights.slowestEntries.length > 0}
            <section class="advanced-section" aria-labelledby="slowest-heading">
              <div class="section-head"><h2 id="slowest-heading">Slowest processing</h2></div>
              {@render EntryList(insights.slowestEntries, formatDuration, formatEntryDate)}
            </section>
          {/if}
        </div>
      </details>
    {/if}
  </main>
</PrimaryPage>

{#snippet DailyDictationChart(
  chart: DictationTimeChart,
  periodLabel: string,
  formatDuration: (seconds: number) => string,
  formatInteger: (value: number) => string,
)}
  <div class="daily-chart" data-insights-chart>
    <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={`${chart.metricLabel}; ${chart.unitLabel}; period ${periodLabel}; ${chart.xAxisDescription}; zero baseline; maximum scale ${chart.scaleLabel}`}>
      {#each chart.ticks as tick (tick.valueSeconds)}
        <line class="chart-grid" x1={chart.plotLeft} x2={chart.plotRight} y1={tick.y} y2={tick.y} />
        <text class="chart-y-label" x="1" y={tick.y + 3}>{tick.label}</text>
      {/each}
      <line class="chart-baseline" x1={chart.plotLeft} x2={chart.plotRight} y1={chart.zeroY} y2={chart.zeroY} />
      {#each chart.bars as bar (bar.date)}
        <rect class="daily-bar" x={bar.x} y={bar.y} width={Math.max(0, bar.width)} height={Math.max(0, bar.height)}>
          <title>{bar.label}: {bar.valueLabel}</title>
        </rect>
      {/each}
    </svg>
    <div class="daily-chart-axis">
      {#if chart.xAxisEndLabel}<span>{chart.xAxisStartLabel}</span><span>{chart.xAxisEndLabel}</span>
      {:else if chart.bars.length === 1}<span>Only recorded day: {chart.xAxisStartLabel}</span>
      {:else}<span>{chart.xAxisStartLabel}</span>{/if}
    </div>
    <p class="daily-chart-note">
      {#if chart.gapDays > 0}{formatInteger(chart.gapDays)} empty calendar {chart.gapDays === 1 ? 'day is' : 'days are'} shown as gaps; fixed-range empty days are zero.
      {:else}Empty calendar days are shown at zero.{/if}
    </p>
  </div>
{/snippet}

{#snippet WordList(words: InsightsWordStat[])}
  <div class="phrase-list">
    {#each words as word (word.text)}<div class="record"><p class="record-value">{word.text}</p><p class="record-sub">{formatStatCount(word.count)} uses</p></div>{/each}
  </div>
{/snippet}

{#snippet EntryList(
  entries: InsightsEntryStat[],
  formatDuration: (seconds: number) => string,
  formatDate: (timestamp: number) => string,
)}
  <div class="entry-list">
    {#each entries as entry (entry.id)}
      <div class="entry-record"><p class="entry-text">{entry.text.replace(/\s+/g, ' ').trim()}</p><p class="record-sub">{formatDate(entry.timestamp)} · {formatDuration(entry.audioDuration)} · {formatStatCount(entry.wordCount)} words · {formatRatio(entry.processingRatio)}</p></div>
    {/each}
  </div>
{/snippet}



<style>
  .insights-view { width: 100%; max-width: 760px; margin: 0 auto; padding: 0 0 24px; color: var(--fg); }
  .page-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 0 26px; }
  .page-head h1 { color: var(--fg2); font-size: 12.5px; font-weight: 400; letter-spacing: .02em; }
  .range-controls { display: flex; align-items: center; gap: 7px; position: relative; font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .range-tabs { display: flex; align-items: center; }
  .range-tabs button, .quiet-toggle, .quiet-ranges button { color: var(--fg3); font-size: 11px; padding: 4px 8px; transition: color .2s var(--ease); }
  .range-tabs button:hover, .quiet-toggle:hover, .quiet-ranges button:hover, .range-tabs button.active, .quiet-ranges button.active { color: var(--fg); }
  .quiet-toggle { padding-right: 0; font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
  .quiet-ranges { position: absolute; z-index: 4; top: calc(100% + 5px); right: 0; display: flex; gap: 2px; padding: 4px 0; background: var(--bg); border-bottom: 1px solid var(--line2); }
  .state-message, .empty-period { color: var(--fg2); font-size: 12px; padding: 12px 0; }
  .indexing-message { margin-bottom: 14px; color: var(--fg3); font-size: 10.5px; line-height: 1.6; }
  .section-label { color: var(--fg3); font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
  .hero-number { margin-top: 12px; font-size: 68px; font-weight: 300; letter-spacing: -.05em; line-height: 1; font-variant-numeric: tabular-nums; }
  .hero-sub { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 14px; color: var(--fg2); font-size: 12.5px; }
  .loading-note { color: var(--fg3); }
  .chart { height: 160px; margin-top: 30px; position: relative; color: var(--fg); }
  .chart-interaction { width: 100%; height: 160px; outline: none; }
  .chart-interaction:focus-visible { outline: 1px solid var(--line2); outline-offset: 2px; }
  .chart svg { display: block; width: 100%; height: 160px; overflow: hidden; }
  .chart-grid { stroke: var(--line); stroke-dasharray: 2 4; }
  .chart-baseline { stroke: var(--line2); }
  .chart-x-label { fill: var(--fg3); font: 9.5px var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .chart-area { fill: url(#insights-word-gradient); }
  .chart-line { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linejoin: round; stroke-linecap: round; }
  .chart-crosshair { stroke: var(--fg3); stroke-dasharray: 2 3; }
  .chart-point { fill: var(--bg); stroke: var(--fg); stroke-width: 1.5; }
  .chart-hit-area { fill: transparent; pointer-events: all; }
  .chart-tooltip { position: absolute; top: -10px; display: flex; gap: 8px; max-width: 90%; transform: translateX(-50%); pointer-events: none; white-space: nowrap; border: 1px solid var(--line2); border-radius: 3px; background: var(--bg); padding: 2px 7px; color: var(--fg); font: 10px var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .chart-tooltip span { color: var(--fg2); }
  .chart-empty { height: 100%; display: flex; align-items: center; color: var(--fg3); font-size: 11px; }
  .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 30px; border-top: 1px solid var(--line); }
  .metric { min-width: 0; padding: 18px 0; border-bottom: 1px solid var(--line); }
  .metric:not(:nth-child(3n + 1)) { padding-left: 18px; border-left: 1px solid var(--line); }
  .metric-value { margin-top: 8px; font-size: 22px; font-weight: 300; letter-spacing: -.02em; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .metric-value small { margin-left: 4px; color: var(--fg3); font-size: 11px; letter-spacing: 0; }
  .section { margin-top: 46px; }
  .section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 16px; }
  .section-head h2 { color: var(--fg2); font-size: 12.5px; font-weight: 400; }
  .section-head > span { color: var(--fg3); font: 10.5px var(--font-mono, "Geist Mono", ui-monospace, monospace); letter-spacing: .03em; text-align: right; }
  .heatmap { position: relative; }
  .heat-months { display: grid; grid-template-columns: repeat(53, minmax(0, 1fr)); gap: 3px; height: 14px; overflow: hidden; color: var(--fg3); font: 9px var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .heat-months span { white-space: nowrap; }
  .heat-grid { display: grid; grid-template-columns: repeat(53, minmax(0, 1fr)); grid-template-rows: repeat(7, auto); grid-auto-flow: column; gap: 3px; }
  .heat-grid i { aspect-ratio: 1; min-width: 0; border-radius: 1.5px; background: var(--fg); opacity: var(--cell-opacity); animation: cell-in .6s var(--ease) both; animation-delay: calc((var(--column, 0) * 10ms) + (var(--row, 0) * 4ms)); }
  .heat-grid i.future { visibility: hidden; }
  @keyframes cell-in { from { opacity: 0; transform: scale(.3); } to { opacity: var(--cell-opacity); transform: none; } }
  .legend { display: flex; justify-content: flex-end; align-items: center; gap: 3px; margin-top: 12px; color: var(--fg3); font: 9px var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .legend i { width: 9px; height: 9px; border-radius: 1.5px; background: var(--fg); }
  .legend span { margin: 0 4px; }
  .hour-bars { height: 72px; display: flex; align-items: flex-end; gap: 3px; }
  .hour-bars i { flex: 1; min-width: 1px; min-height: 1px; background: var(--fg); opacity: .25; transition: height 1s var(--ease); }
  .hour-bars i.peak { opacity: 1; }
  .hour-labels { display: flex; justify-content: space-between; margin-top: 8px; color: var(--fg3); font: 9px var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .common-words { display: grid; grid-template-columns: 1fr; }
  .common-word { display: grid; grid-template-columns: 104px minmax(0, 1fr) 44px; align-items: center; gap: 16px; padding: 7px 0; font-size: 13px; }
  .common-word-rule { height: 1px; position: relative; background: var(--line2); }
  .common-word-rule i { height: 2px; position: absolute; top: -.5px; left: 0; background: var(--fg); transition: width 1.1s var(--ease); }
  .common-word-count { color: var(--fg3); text-align: right; font: 10.5px var(--font-mono, "Geist Mono", ui-monospace, monospace); font-variant-numeric: tabular-nums; }
  .record { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 16px; padding: 15px 0; border-top: 1px solid var(--line); }
  .record .section-label { padding-top: 3px; }
  .record-value { font-size: 14px; }
  .record-sub { margin-top: 4px; color: var(--fg2); font-size: 12.5px; line-height: 1.5; }
  .more-insights { margin-top: 46px; border-top: 1px solid var(--line); color: var(--fg2); }
  .more-insights summary { width: fit-content; padding: 13px 0; cursor: pointer; color: var(--fg3); font-size: 11px; list-style: none; }
  .more-insights summary::-webkit-details-marker { display: none; }
  .more-insights summary::after { content: ' +'; color: var(--fg3); }
  .more-insights[open] summary::after { content: ' −'; }
  .more-content { padding: 12px 0 8px; }
  .advanced-section { margin-top: 32px; }
  .phrase-list .record { grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; }
  .entry-record { padding: 12px 0; border-top: 1px solid var(--line); }
  .entry-text { display: -webkit-box; overflow: hidden; color: var(--fg2); font-size: 12px; line-height: 1.6; line-clamp: 2; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .daily-chart svg { display: block; width: 100%; height: 112px; overflow: visible; }
  .chart-y-label { fill: var(--fg3); font: 8px var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .daily-bar { fill: var(--fg); opacity: .8; }
  .daily-chart-axis { display: flex; justify-content: space-between; gap: 12px; min-height: 16px; padding-left: 34px; color: var(--fg3); font: 9px var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .daily-chart-note { margin-top: 8px; color: var(--fg3); font-size: 10px; line-height: 1.5; }
  @media (max-width: 340px) {
    .range-controls { gap: 2px; }
    .range-tabs button { padding-right: 6px; padding-left: 6px; }
    .hero-number { font-size: 58px; }
    .metric:not(:nth-child(3n + 1)) { padding-left: 10px; }
    .metric-value { font-size: 19px; }
    .section-head { align-items: flex-start; }
    .section-head > span { max-width: 58%; }
    .heat-grid, .heat-months { gap: 2px; }
    .common-word { grid-template-columns: 82px minmax(0, 1fr) 36px; gap: 10px; font-size: 12px; }
    .record { grid-template-columns: 98px minmax(0, 1fr); gap: 10px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .heat-grid i, .hour-bars i, .common-word-rule i { animation: none; transition: none; }
  }
</style>
