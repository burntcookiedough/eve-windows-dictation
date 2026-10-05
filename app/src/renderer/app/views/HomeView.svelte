<script lang="ts">
  import { onMount } from 'svelte';
  import type { HistoryEntryWithGroup, InsightsResponse, Settings } from '$shared/types';
  import PrimaryPage from '../components/PrimaryPage.svelte';
  import Cactus from '../components/Cactus.svelte';
  import { serverStatusState, retryManagedServer, type ServerStatusPhase } from '../server-status';
  import { recordingRendererState } from '../recording-renderer-state';

  interface Props {
    onNavigate: (view: 'history' | 'insights' | 'settings') => void;
  }

  interface ActivityDay {
    date: Date;
    key: string;
    words: number;
    dictations: number;
    today: boolean;
  }

  let { onNavigate }: Props = $props();
  let now = $state(new Date());
  let insights = $state<InsightsResponse | null>(null);
  let latestEntry = $state<HistoryEntryWithGroup | null>(null);
  let quickHotkey = $state('—');
  let longHotkey = $state('—');
  let retrying = $state(false);
  let plant: HTMLDivElement | null = null;

  let serverSnapshot = $derived($serverStatusState);
  let motion = $derived($recordingRendererState);
  let model = $derived(serverSnapshot.state?.modelDownload);

  const phaseCopy: Record<ServerStatusPhase, string> = {
    connecting: 'connecting',
    stale: 'refreshing readiness',
    unavailable: 'speech service unavailable',
    missing: 'speech model not prepared',
    partial: 'speech model needs more files',
    checking: 'checking speech model files',
    downloading: 'downloading speech model',
    loading: 'loading speech model',
    ready: 'ready',
    error: 'speech setup needs attention',
  };

  let homeStatus = $derived.by(() => {
    const recordingState = motion.recording?.state;
    if (recordingState === 'listening') {
      const elapsed = motion.listeningSince === null ? 0 : Math.max(0, Math.floor((now.getTime() - motion.listeningSince) / 1000));
      return `listening · ${formatDuration(elapsed)}`;
    }
    if (recordingState === 'processing' || recordingState === 'transcribing') return 'transcribing';
    if (recordingState === 'success' || motion.cactusState === 'done') return 'done';
    if (recordingState === 'error') return 'dictation error';

    if (serverSnapshot.phase !== 'ready') {
      const percent = model?.progress_percent;
      return serverSnapshot.phase === 'downloading' && typeof percent === 'number' && Number.isFinite(percent)
        ? `downloading · ${Math.round(percent)}%`
        : phaseCopy[serverSnapshot.phase] ?? 'checking readiness';
    }

    return 'ready';
  });

  let statusAction = $derived.by(() => {
    if ((serverSnapshot.phase === 'error' || serverSnapshot.phase === 'unavailable') && serverSnapshot.state?.managed) return 'retry';
    if (serverSnapshot.phase === 'error' || serverSnapshot.phase === 'unavailable' || serverSnapshot.phase === 'missing' || serverSnapshot.phase === 'partial') return 'open settings';
    return null;
  });

  let insightsReady = $derived(insights !== null && !insights.indexing.isIndexing);
  let todayWords = $derived(insightsReady ? insights?.summary.totalWords ?? null : null);
  let spokenMinutes = $derived(insightsReady && insights ? (insights.summary.totalAudioSeconds / 60).toFixed(1) : null);
  let pace = $derived(insightsReady && insights ? Math.round(insights.summary.avgWpm) : null);
  let activityByDate = $derived(new Map((insights?.yearActivity ?? []).map((day) => [day.date, day])));
  let activityDays = $derived.by((): ActivityDay[] => {
    if (!insightsReady || !insights?.yearActivity) return [];
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const mondayOffset = (today.getDay() + 6) % 7;
    const firstDay = addLocalDays(today, -28 - mondayOffset);
    return Array.from({ length: 35 }, (_, index) => {
      const date = addLocalDays(firstDay, index);
      const key = localDayKey(date);
      const summary = activityByDate.get(key);
      return {
        date,
        key,
        words: summary?.words ?? 0,
        dictations: summary?.dictations ?? 0,
        today: key === localDayKey(today),
      };
    });
  });
  let currentStreak = $derived.by(() => {
    const streak = insights?.currentStreakDays;
    return insightsReady && typeof streak === 'number' && Number.isFinite(streak)
      ? Math.max(0, Math.floor(streak))
      : null;
  });
  let activityPeak = $derived(Math.max(0, ...activityDays.map((day) => day.words)));
  let greeting = $derived(
    now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening'
  );
  let todayLabel = $derived(now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));

  function localDayKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function addLocalDays(date: Date, count: number): Date {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    next.setDate(next.getDate() + count);
    return next;
  }

  function formatDuration(seconds: number): string {
    const rounded = Math.max(0, Math.floor(seconds));
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
  }

  function formatNumber(value: number | null): string {
    return value === null || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('en-US');
  }

  function formatLatestTime(timestamp: number): string {
    const minutes = Math.max(0, Math.round((now.getTime() - timestamp) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
    return new Date(timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function activityOpacity(words: number): number {
    if (words <= 0 || activityPeak <= 0) return .07;
    const share = words / activityPeak;
    if (share < .2) return .18;
    if (share < .4) return .34;
    if (share < .7) return .55;
    return .85;
  }

  function handlePlantPointerMove(event: PointerEvent): void {
    if (!plant) return;
    const rect = plant.getBoundingClientRect();
    const horizontalDistance = event.clientX - (rect.left + rect.width / 2);
    const lean = Math.max(-1, Math.min(1, horizontalDistance / 320)) * 2.5;
    plant.style.setProperty('--lean', String(lean));
  }

  function resetPlantLean(): void {
    plant?.style.setProperty('--lean', '0');
  }

  async function handleStatusAction(): Promise<void> {
    if (statusAction === 'retry') {
      if (retrying) return;
      retrying = true;
      try {
        await retryManagedServer();
      } finally {
        retrying = false;
      }
      return;
    }
    onNavigate('settings');
  }

  onMount(() => {
    let active = true;
    let dataRequest = 0;
    let historyRevision = 0;
    let settingsRequest = 0;
    let currentSettingsRevision = 0;
    let indexingRefresh: ReturnType<typeof setTimeout> | undefined;

    async function loadInsights(): Promise<void> {
      if (indexingRefresh !== undefined) clearTimeout(indexingRefresh);
      const request = ++dataRequest;
      const today = await window.murmurMain.getInsights('today').catch(() => null);
      if (!active || request !== dataRequest) return;
      insights = today;
      if (today?.indexing.isIndexing) {
        indexingRefresh = setTimeout(() => {
          if (active) void loadInsights();
        }, 1000);
      }
    }

    async function loadLatestEntry(): Promise<void> {
      const revision = historyRevision;
      try {
        const response = await window.murmurMain.getHistoryEntries(0, 1);
        if (active && historyRevision === revision) latestEntry = response.entries[0] ?? null;
      } catch {
        if (active && historyRevision === revision) latestEntry = null;
      }
    }

    async function loadHotkeys(settings: Settings): Promise<void> {
      const request = ++settingsRequest;
      try {
        const [quick, long] = await Promise.all([
          window.murmurMain.getHotkeyDisplayName(settings.hotkey),
          window.murmurMain.getHotkeyDisplayName(settings.longHotkey),
        ]);
        if (!active || request !== settingsRequest) return;
        quickHotkey = quick.toLowerCase();
        longHotkey = long.toLowerCase();
      } catch {
        if (!active || request !== settingsRequest) return;
        quickHotkey = 'shortcut unavailable';
        longHotkey = 'shortcut unavailable';
      }
    }

    const unsubscribeHistory = window.murmurMain.onNewHistoryEntry((entry) => {
      historyRevision += 1;
      latestEntry = entry;
      void loadInsights();
    });
    const refreshAfterDelete = (event: Event) => {
      const detail = (event as CustomEvent<{ ids?: string[]; deleted?: boolean }>).detail;
      if (!detail?.deleted || !detail.ids?.length) return;
      historyRevision += 1;
      if (latestEntry && detail.ids.includes(latestEntry.id)) latestEntry = null;
      void loadInsights();
      void loadLatestEntry();
    };
    window.addEventListener('history-delete-committed', refreshAfterDelete);
    const unsubscribeSettings = window.murmurMain.onSettingsChanged((settings) => {
      currentSettingsRevision += 1;
      void loadHotkeys(settings);
    });
    const refreshClock = window.setInterval(() => {
      const previousDay = localDayKey(now);
      now = new Date();
      if (localDayKey(now) !== previousDay) {
        void loadInsights();
        void loadLatestEntry();
      }
    }, 1000);

    void loadLatestEntry();
    void loadInsights();
    void window.murmurMain.getSettings().then((settings) => {
      if (active && currentSettingsRevision === 0) void loadHotkeys(settings);
    }).catch(() => {
      if (active) {
        quickHotkey = 'shortcut unavailable';
        longHotkey = 'shortcut unavailable';
      }
    });

    return () => {
      active = false;
      dataRequest += 1;
      settingsRequest += 1;
      window.clearInterval(refreshClock);
      if (indexingRefresh !== undefined) clearTimeout(indexingRefresh);
      unsubscribeHistory();
      window.removeEventListener('history-delete-committed', refreshAfterDelete);
      unsubscribeSettings();
    };
  });
</script>

<PrimaryPage page="home" scrollOwner="home">
  <div class="home-view" role="presentation" onpointermove={handlePlantPointerMove} onpointerleave={resetPlantLean}>
    <header class="home-top" data-r style="--r:0">
      <span>{greeting}</span>
      <time class="home-date" datetime={localDayKey(now)}>{todayLabel}</time>
    </header>

    <div class="home-main">
      <section class="home-presence" data-r style="--r:1" aria-label="Eve recording presence">
        <div class="home-stage">
          <div class="home-rings" class:home-rings--active={motion.cactusState === 'listening'} aria-hidden="true"><span></span><span></span><span></span></div>
          <div class="home-plant" bind:this={plant}>
            <Cactus
              class="home-cactus-svg"
              state={motion.cactusState}
              level={motion.audioLevel}
              homeTarget
            />
          </div>
          <div class="home-ground"></div>
        </div>
        <div class="home-status" aria-label={`Speech service: ${homeStatus}`}>
          <span
            class="home-status__dot"
            class:home-status__dot--listening={motion.cactusState === 'listening'}
            class:home-status__dot--transcribing={motion.cactusState === 'transcribing'}
            aria-hidden="true"
          ></span>
          <span>{homeStatus}</span>
          {#if statusAction}
            <button type="button" onclick={handleStatusAction} disabled={retrying}>
              {retrying ? 'retrying' : statusAction}
            </button>
          {/if}
        </div>
      </section>

      <section class="home-stats" data-r style="--r:2" aria-label="Today's dictation activity">
        <div class="section-label">today</div>
        <div class="home-words" aria-live="off">
          <span>{formatNumber(todayWords)}</span>
          <small>words</small>
        </div>
        <div class="home-stat-rows">
          <div class="home-stat-row"><span>Spoken</span><b><span>{spokenMinutes ?? '—'}</span><small>min</small></b></div>
          <div class="home-stat-row"><span>Pace</span><b><span>{formatNumber(pace)}</span><small>wpm</small></b></div>
          <div class="home-stat-row"><span>Streak</span><b><span>{formatNumber(currentStreak)}</span><small>days</small></b></div>
        </div>
        <div class="home-activity">
          <div class="section-label">last 5 weeks</div>
          <div class="home-activity-weekdays mono" aria-hidden="true">
            <span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span>
          </div>
          <div class="home-activity-grid" role="img" aria-label="Dictation activity for the last five weeks">
            {#each activityDays as day (day.key)}
              <span
                class="home-activity-cell"
                class:home-activity-cell--today={day.today}
                title={`${day.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${day.words.toLocaleString('en-US')} words`}
                style={`--o:${activityOpacity(day.words)}`}
              ></span>
            {/each}
          </div>
        </div>
      </section>
    </div>

    <p class="home-last" data-r style="--r:3">
      {latestEntry?.text ?? (insights?.hasData === false && !insights.indexing.isIndexing ? 'No dictations yet' : '')}
    </p>
    <div class="home-last-meta mono" data-r style="--r:4">
      {#if latestEntry}
        last · {formatLatestTime(latestEntry.timestamp)}
      {/if}
    </div>
    <footer class="home-keys mono" data-r style="--r:5">
      <span>quick<b>{quickHotkey}</b></span>
      <span>long<b>{longHotkey}</b></span>
    </footer>
  </div>
</PrimaryPage>
