<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { toast } from '$lib/toast.svelte';
  import type {
    ConnectionStatePayload,
    RecordingStatePayload,
    Settings,
    TranscriptionPayload,
  } from '$shared/types';

  interface TranscriptStreamItem {
    id: number;
    type: 'partial' | 'final';
    text: string;
    confidence: number;
    timestamp: number;
  }

  interface ActivityItem {
    id: number;
    message: string;
    detail: string;
    tone: 'neutral' | 'good' | 'warn';
    timestamp: number;
  }

  interface RecordingSnapshot {
    recording: RecordingStatePayload;
    connection: ConnectionStatePayload;
    transcription: TranscriptionPayload | null;
  }

  const murmurMain = (window as unknown as Window & { murmurMain: any }).murmurMain;

  let recording = $state<RecordingStatePayload>({ state: 'idle', isRecording: false });
  let connection = $state<ConnectionStatePayload>({ status: 'disconnected' });
  let settings = $state<Settings | null>(null);
  let latestPartial = $state('');
  let latestFinal = $state('');
  let streamItems = $state<TranscriptStreamItem[]>([]);
  let activity = $state<ActivityItem[]>([]);
  let actionLoading = $state<'start' | 'stop' | 'toggle' | null>(null);
  let nextEventId = 1;
  const MAX_STREAM_ITEMS = 80;
  const MAX_ACTIVITY_ITEMS = 60;
  const cleanupFns: Array<() => void> = [];

  let canStart = $derived(!recording.isRecording && actionLoading === null);
  let canStop = $derived(recording.isRecording && actionLoading === null);

  function recordingStateClass(state: RecordingStatePayload['state']): string {
    if (state === 'success') return 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50';
    if (state === 'error') return 'bg-red-900/40 text-red-300 border-red-700/50';
    if (state === 'listening' || state === 'transcribing' || state === 'processing') {
      return 'bg-amber-900/30 text-amber-300 border-amber-700/50';
    }
    return 'bg-zinc-800/80 text-zinc-300 border-zinc-700';
  }

  function connectionStateClass(status: ConnectionStatePayload['status']): string {
    if (status === 'connected') return 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50';
    if (status === 'error') return 'bg-red-900/40 text-red-300 border-red-700/50';
    if (status === 'connecting') return 'bg-amber-900/30 text-amber-300 border-amber-700/50';
    return 'bg-zinc-800/80 text-zinc-300 border-zinc-700';
  }

  function pushActivity(message: string, detail: string, tone: ActivityItem['tone'] = 'neutral') {
    activity = [
      {
        id: nextEventId++,
        message,
        detail,
        tone,
        timestamp: Date.now(),
      },
      ...activity,
    ].slice(0, MAX_ACTIVITY_ITEMS);
  }

  function pushStreamItem(payload: TranscriptionPayload) {
    if (!payload.text.trim()) return;

    const newest = streamItems[0];
    if (
      payload.type === 'partial' &&
      newest &&
      newest.type === 'partial' &&
      newest.text === payload.text
    ) {
      return;
    }

    streamItems = [
      {
        id: nextEventId++,
        type: payload.type,
        text: payload.text,
        confidence: payload.confidence,
        timestamp: Date.now(),
      },
      ...streamItems,
    ].slice(0, MAX_STREAM_ITEMS);
  }

  function applySnapshot(snapshot: RecordingSnapshot) {
    recording = snapshot.recording;
    connection = snapshot.connection;

    if (snapshot.transcription) {
      pushStreamItem(snapshot.transcription);
      if (snapshot.transcription.type === 'final') {
        latestFinal = snapshot.transcription.text;
      } else {
        latestPartial = snapshot.transcription.text;
      }
    }
  }

  function formatClock(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  }

  function clearSessionPane() {
    latestPartial = '';
    latestFinal = '';
    streamItems = [];
    activity = [];
    pushActivity('Cleared panel', 'Session output and event feed reset');
  }

  async function runAction(action: 'start' | 'stop' | 'toggle') {
    if (actionLoading) return;
    actionLoading = action;

    try {
      const snapshot =
        action === 'start'
          ? await murmurMain.startRecording()
          : action === 'stop'
            ? await murmurMain.stopRecording()
            : await murmurMain.toggleRecording();

      applySnapshot(snapshot);
      pushActivity(
        action === 'start' ? 'Start requested' : action === 'stop' ? 'Stop requested' : 'Toggle requested',
        'Command sent to main process',
        'neutral'
      );
    } catch (error) {
      console.error(`Failed to ${action} recording`, error);
      toast(`Failed to ${action} recording`, 'error');
      pushActivity(
        'Command failed',
        error instanceof Error ? error.message : `Could not ${action} recording`,
        'warn'
      );
    } finally {
      actionLoading = null;
    }
  }

  function copyFinalResult() {
    if (!latestFinal) return;
    murmurMain.copyToClipboard(latestFinal);
    toast('Final result copied');
  }

  onMount(() => {
    const init = async () => {
      settings = await murmurMain.getSettings();
      const snapshot: RecordingSnapshot = await murmurMain.getRecordingDebugState();
      applySnapshot(snapshot);
      pushActivity('Panel ready', 'Live session subscriptions started');
    };

    cleanupFns.push(
      murmurMain.onRecordingState((payload: RecordingStatePayload) => {
        const stateChanged = payload.state !== recording.state || payload.isRecording !== recording.isRecording;
        recording = payload;
        if (!stateChanged) return;

        const tone = payload.state === 'error' ? 'warn' : payload.state === 'success' ? 'good' : 'neutral';
        pushActivity('Recording state changed', `${payload.state}`, tone);
      })
    );

    cleanupFns.push(
      murmurMain.onConnectionState((payload: ConnectionStatePayload) => {
        const changed = payload.status !== connection.status || payload.error !== connection.error;
        connection = payload;
        if (!changed) return;

        const detail = payload.error ? `${payload.status}: ${payload.error}` : payload.status;
        const tone = payload.status === 'connected' ? 'good' : payload.status === 'error' ? 'warn' : 'neutral';
        pushActivity('Connection update', detail, tone);
      })
    );

    cleanupFns.push(
      murmurMain.onTranscription((payload: TranscriptionPayload) => {
        pushStreamItem(payload);
        if (payload.type === 'final') {
          latestFinal = payload.text;
          latestPartial = '';
          pushActivity('Final transcript received', `${Math.round(payload.confidence * 100)}% confidence`, 'good');
        } else {
          latestPartial = payload.text;
        }
      })
    );

    void init().catch((error) => {
      console.error('Failed to initialize test panel', error);
      toast('Failed to load test panel state', 'error');
      pushActivity('Initialization failed', 'Could not load current session state', 'warn');
    });
  });

  onDestroy(() => {
    cleanupFns.forEach((fn) => fn());
    murmurMain.removeRecordingListeners();
  });
</script>

<div class="h-full p-6 pr-2">
  <div class="h-full overflow-y-auto pr-4">
    <div class="space-y-5">
      <section class="rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 p-5">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div class="space-y-1.5">
            <p class="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">Transcription Lab</p>
            <h2 class="text-xl font-semibold text-zinc-100">Test the full recording pipeline from this page</h2>
            <p class="text-sm text-zinc-400">
              Start or stop sessions, inspect live protocol output, and validate final transcription quality without using the global hotkey.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              onclick={() => runAction('start')}
              disabled={!canStart}
              class="px-4 py-2 text-sm font-medium rounded-lg transition-colors
                {canStart
                  ? 'bg-emerald-900/60 text-emerald-200 hover:bg-emerald-800/70 cursor-pointer'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
            >
              {actionLoading === 'start' ? 'Starting...' : 'Start'}
            </button>
            <button
              onclick={() => runAction('stop')}
              disabled={!canStop}
              class="px-4 py-2 text-sm font-medium rounded-lg transition-colors
                {canStop
                  ? 'bg-red-900/60 text-red-200 hover:bg-red-800/70 cursor-pointer'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
            >
              {actionLoading === 'stop' ? 'Stopping...' : 'Stop'}
            </button>
            <button
              onclick={() => runAction('toggle')}
              disabled={actionLoading !== null}
              class="px-4 py-2 text-sm font-medium rounded-lg transition-colors
                {actionLoading === null
                  ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 cursor-pointer'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
            >
              {actionLoading === 'toggle' ? 'Toggling...' : 'Toggle'}
            </button>
            <button
              onclick={clearSessionPane}
              class="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-900 text-zinc-300 hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              Clear Panel
            </button>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-4">
          <h3 class="text-sm font-semibold text-zinc-200">Session status</h3>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
              <p class="text-xs text-zinc-500 mb-2 uppercase tracking-wide">Recording state</p>
              <span class="inline-flex rounded-md border px-2.5 py-1 text-xs font-medium {recordingStateClass(recording.state)}">
                {recording.state}
              </span>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
              <p class="text-xs text-zinc-500 mb-2 uppercase tracking-wide">Connection</p>
              <span class="inline-flex rounded-md border px-2.5 py-1 text-xs font-medium {connectionStateClass(connection.status)}">
                {connection.status}
              </span>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
              <p class="text-xs text-zinc-500 mb-2 uppercase tracking-wide">Activation mode</p>
              <p class="text-sm text-zinc-200">{settings?.holdToTalk ? 'Hold-to-talk' : 'Toggle-to-talk'}</p>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
              <p class="text-xs text-zinc-500 mb-2 uppercase tracking-wide">Input device</p>
              <p class="text-sm text-zinc-200 font-mono truncate" title={settings?.selectedDeviceId ?? 'default'}>
                {settings?.selectedDeviceId ?? 'default'}
              </p>
            </div>
          </div>
          {#if connection.error}
            <p class="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {connection.error}
            </p>
          {/if}
        </div>

        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <h3 class="text-sm font-semibold text-zinc-200">Latest result</h3>
            <button
              onclick={copyFinalResult}
              disabled={!latestFinal}
              class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                {latestFinal
                  ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 cursor-pointer'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
            >
              Copy Final
            </button>
          </div>
          <div class="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 min-h-[130px]">
            {#if latestFinal}
              <p class="text-sm leading-relaxed text-zinc-200">{latestFinal}</p>
            {:else}
              <p class="text-sm text-zinc-500 italic">No final transcript yet</p>
            {/if}
          </div>
          <div>
            <p class="text-xs text-zinc-500 uppercase tracking-wide mb-2">Current partial</p>
            <p class="text-sm text-zinc-300 min-h-[20px]">{latestPartial || '-'}</p>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 class="text-sm font-semibold text-zinc-200 mb-3">Protocol stream</h3>
          <div class="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 max-h-80 overflow-y-auto">
            {#if streamItems.length === 0}
              <p class="text-sm text-zinc-500">No transcription frames yet</p>
            {:else}
              <div class="space-y-2 font-mono text-xs">
                {#each streamItems as item}
                  <div class="rounded-lg border px-2.5 py-2 {item.type === 'final' ? 'border-emerald-800/60 bg-emerald-950/15' : 'border-zinc-800 bg-zinc-900/70'}">
                    <div class="mb-1 flex items-center justify-between gap-2">
                      <span class="text-[11px] uppercase tracking-wide {item.type === 'final' ? 'text-emerald-300' : 'text-zinc-400'}">{item.type}</span>
                      <span class="text-zinc-600">{formatClock(item.timestamp)} - {Math.round(item.confidence * 100)}%</span>
                    </div>
                    <p class="text-zinc-200 break-words">{item.text}</p>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 class="text-sm font-semibold text-zinc-200 mb-3">Activity timeline</h3>
          <div class="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 max-h-80 overflow-y-auto">
            {#if activity.length === 0}
              <p class="text-sm text-zinc-500">No events yet</p>
            {:else}
              <div class="space-y-2.5">
                {#each activity as event}
                  <div class="rounded-lg border px-2.5 py-2
                    {event.tone === 'good'
                      ? 'border-emerald-800/60 bg-emerald-950/15'
                      : event.tone === 'warn'
                        ? 'border-red-800/50 bg-red-950/20'
                        : 'border-zinc-800 bg-zinc-900/70'}">
                    <div class="flex items-center justify-between gap-2">
                      <p class="text-sm text-zinc-200">{event.message}</p>
                      <span class="text-xs font-mono text-zinc-500">{formatClock(event.timestamp)}</span>
                    </div>
                    <p class="text-xs text-zinc-400 mt-1">{event.detail}</p>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </section>
    </div>
  </div>
</div>
