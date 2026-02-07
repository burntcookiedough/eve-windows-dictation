<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { toast } from '$lib/toast.svelte';
  import type {
    ConnectionStatePayload,
    RecordingStatePayload,
    Settings,
    TranscriptionPayload,
  } from '$shared/types';

  interface SessionFrame {
    id: number;
    payload: TranscriptionPayload;
    timestamp: number;
  }

  interface SessionEvent {
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

  interface SessionRecord {
    id: number;
    startedAt: number;
    endedAt: number | null;
    recordingState: RecordingStatePayload['state'];
    connectionState: ConnectionStatePayload['status'];
    connectionError: string | undefined;
    latestPartial: string;
    latestFinal: string;
    finalCount: number;
    frames: SessionFrame[];
    events: SessionEvent[];
  }

  const murmurMain = (window as unknown as Window & { murmurMain: any }).murmurMain;

  let recording = $state<RecordingStatePayload>({ state: 'idle', isRecording: false });
  let connection = $state<ConnectionStatePayload>({ status: 'disconnected' });
  let settings = $state<Settings | null>(null);
  let sessions = $state<SessionRecord[]>([]);
  let activeSessionId = $state<number | null>(null);
  let actionLoading = $state<'start' | 'stop' | null>(null);
  let nextEventId = 1;
  let nextSessionId = 1;
  let nowMs = $state(Date.now());
  let tickInterval: ReturnType<typeof setInterval> | null = null;
  const cleanupFns: Array<() => void> = [];

  let activeSession = $derived(
    sessions.find((session) => session.id === activeSessionId)
      ?? (sessions.length > 0 ? sessions[0]! : null)
  );
  let primaryButtonLabel = $derived(
    actionLoading === 'start'
      ? 'Starting...'
      : actionLoading === 'stop'
        ? 'Stopping...'
        : recording.isRecording
          ? 'Stop Session'
          : 'Start Session'
  );
  let canRunPrimaryAction = $derived(actionLoading === null);

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

  function createSession(reason: string): number {
    const id = nextSessionId++;
    const startedAt = Date.now();
    const session: SessionRecord = {
      id,
      startedAt,
      endedAt: null,
      recordingState: recording.state,
      connectionState: connection.status,
      connectionError: connection.error,
      latestPartial: '',
      latestFinal: '',
      finalCount: 0,
      frames: [],
      events: [],
    };

    sessions = sessions.map((existing) => (
      existing.endedAt === null
        ? { ...existing, endedAt: startedAt }
        : existing
    ));
    sessions = [session, ...sessions];
    activeSessionId = id;
    addSessionEvent(id, 'Session created', reason, 'neutral');
    return id;
  }

  function ensureActiveSession(reason: string): number {
    if (activeSessionId !== null && sessions.some((session) => session.id === activeSessionId)) {
      return activeSessionId;
    }
    return createSession(reason);
  }

  function updateSession(sessionId: number, updater: (session: SessionRecord) => SessionRecord) {
    sessions = sessions.map((session) => (session.id === sessionId ? updater(session) : session));
  }

  function addSessionEvent(
    sessionId: number,
    message: string,
    detail: string,
    tone: SessionEvent['tone'] = 'neutral'
  ) {
    const event: SessionEvent = {
      id: nextEventId++,
      message,
      detail,
      tone,
      timestamp: Date.now(),
    };

    updateSession(sessionId, (session) => ({
      ...session,
      events: [event, ...session.events],
    }));
  }

  function addTranscriptionFrame(sessionId: number, payload: TranscriptionPayload) {
    const frame: SessionFrame = {
      id: nextEventId++,
      payload,
      timestamp: Date.now(),
    };

    updateSession(sessionId, (session) => ({
      ...session,
      frames: [frame, ...session.frames],
      latestPartial: payload.type === 'partial' ? payload.text : '',
      latestFinal: payload.type === 'final' ? payload.text : session.latestFinal,
      finalCount: payload.type === 'final' ? session.finalCount + 1 : session.finalCount,
    }));
  }

  function applySnapshot(snapshot: RecordingSnapshot) {
    recording = snapshot.recording;
    connection = snapshot.connection;

    if (!snapshot.recording.isRecording && !snapshot.transcription) {
      return;
    }

    const sessionId = ensureActiveSession('Recovered from current app state');
    updateSession(sessionId, (session) => ({
      ...session,
      recordingState: snapshot.recording.state,
      connectionState: snapshot.connection.status,
      connectionError: snapshot.connection.error,
    }));

    if (snapshot.transcription) {
      addTranscriptionFrame(sessionId, snapshot.transcription);
    }
  }

  function formatClock(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  }

  function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  function getSessionDurationMs(session: SessionRecord): number {
    const end = session.endedAt ?? nowMs;
    return Math.max(0, end - session.startedAt);
  }

  function toneClass(tone: SessionEvent['tone']): string {
    if (tone === 'good') return 'border-emerald-800/60 bg-emerald-950/15';
    if (tone === 'warn') return 'border-red-800/50 bg-red-950/20';
    return 'border-zinc-800 bg-zinc-900/70';
  }

  function badgeClass(active: boolean): string {
    return active
      ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
      : 'bg-zinc-800/80 text-zinc-300 border-zinc-700';
  }

  async function handlePrimaryAction() {
    if (actionLoading) return;
    const shouldStop = recording.isRecording;
    actionLoading = shouldStop ? 'stop' : 'start';
    const sessionId = shouldStop
      ? activeSessionId
      : ensureActiveSession('Manual start requested from lab');

    try {
      if (sessionId !== null) {
        addSessionEvent(
          sessionId,
          'Command',
          shouldStop ? 'Stop requested' : 'Start requested',
          'neutral'
        );
      }

      const snapshot: RecordingSnapshot = shouldStop
        ? await murmurMain.stopRecording()
        : await murmurMain.startRecording();

      applySnapshot(snapshot);
    } catch (error) {
      console.error('Failed to run recording action', error);
      toast(shouldStop ? 'Failed to stop recording' : 'Failed to start recording', 'error');
      if (sessionId !== null) {
        addSessionEvent(
          sessionId,
          'Command failed',
          error instanceof Error ? error.message : 'Unknown command failure',
          'warn'
        );
      }
    } finally {
      actionLoading = null;
    }
  }

  function copySelectedFinal() {
    if (!activeSession?.latestFinal) return;
    murmurMain.copyToClipboard(activeSession.latestFinal);
    toast('Session final copied');
  }

  function clearSessions() {
    sessions = [];
    activeSessionId = null;
  }

  function selectSession(sessionId: number) {
    activeSessionId = sessionId;
  }

  onMount(() => {
    tickInterval = setInterval(() => {
      nowMs = Date.now();
    }, 1000);

    const init = async () => {
      settings = await murmurMain.getSettings();
      const snapshot: RecordingSnapshot = await murmurMain.getRecordingDebugState();
      applySnapshot(snapshot);

      if (activeSessionId !== null) {
        addSessionEvent(activeSessionId, 'Panel ready', 'Live subscriptions started');
      }
    };

    cleanupFns.push(
      murmurMain.onRecordingState((payload: RecordingStatePayload) => {
        const previous = recording;
        recording = payload;

        const hasChanged =
          payload.state !== previous.state || payload.isRecording !== previous.isRecording;
        if (!hasChanged) return;

        let sessionId = activeSessionId;

        if (payload.isRecording && !previous.isRecording) {
          sessionId = createSession('Recording became active');
        } else if (sessionId === null) {
          sessionId = ensureActiveSession('Recording update received');
        }

        updateSession(sessionId, (session) => ({
          ...session,
          recordingState: payload.state,
        }));

        const tone = payload.state === 'error' ? 'warn' : payload.state === 'success' ? 'good' : 'neutral';
        addSessionEvent(sessionId, 'Recording state', payload.state, tone);

        if (!payload.isRecording && previous.isRecording) {
          updateSession(sessionId, (session) => ({
            ...session,
            endedAt: session.endedAt ?? Date.now(),
          }));
          addSessionEvent(sessionId, 'Session ended', 'Recording returned to idle');
        }
      })
    );

    cleanupFns.push(
      murmurMain.onConnectionState((payload: ConnectionStatePayload) => {
        const previous = connection;
        connection = payload;
        const changed = payload.status !== previous.status || payload.error !== previous.error;
        if (!changed) return;

        const sessionId =
          activeSessionId !== null
            ? activeSessionId
            : ensureActiveSession('Connection update received before session selection');

        updateSession(sessionId, (session) => ({
          ...session,
          connectionState: payload.status,
          connectionError: payload.error,
        }));

        const detail = payload.error ? `${payload.status}: ${payload.error}` : payload.status;
        const tone = payload.status === 'connected' ? 'good' : payload.status === 'error' ? 'warn' : 'neutral';
        addSessionEvent(sessionId, 'Connection', detail, tone);
      })
    );

    cleanupFns.push(
      murmurMain.onTranscription((payload: TranscriptionPayload) => {
        const sessionId = ensureActiveSession('Transcription frame received');
        addTranscriptionFrame(sessionId, payload);

        if (payload.type === 'final') {
          addSessionEvent(
            sessionId,
            'Final transcript',
            `${Math.round(payload.confidence * 100)}% confidence`,
            'good'
          );
        }
      })
    );

    void init().catch((error) => {
      console.error('Failed to initialize test panel', error);
      toast('Failed to load test panel state', 'error');
      const sessionId = ensureActiveSession('Initialization failed before any session was active');
      addSessionEvent(sessionId, 'Initialization failed', 'Could not load current session state', 'warn');
    });
  });

  $effect(() => {
    if (activeSessionId !== null && !sessions.some((session) => session.id === activeSessionId)) {
      activeSessionId = sessions.length > 0 ? sessions[0]!.id : null;
      return;
    }

    if (activeSessionId === null && sessions.length > 0) {
      activeSessionId = sessions[0]!.id;
    }
  });

  $effect(() => {
    if (!recording.isRecording && sessions.some((session) => session.endedAt === null)) {
      const endedAt = Date.now();
      sessions = sessions.map((session) => (
        session.endedAt === null
          ? { ...session, endedAt }
          : session
      ));
    }
  });

  onDestroy(() => {
    cleanupFns.forEach((fn) => fn());
    if (tickInterval) {
      clearInterval(tickInterval);
    }
    murmurMain.removeRecordingListeners();
  });
</script>

<div class="h-full p-6 pr-2">
  <div class="h-full overflow-y-auto pr-4">
    <div class="space-y-4">
      <section class="rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 p-5">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div class="space-y-1">
            <p class="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">Transcription Lab</p>
            <h2 class="text-xl font-semibold text-zinc-100">Run and inspect sessions without the global hotkey</h2>
            <p class="text-sm text-zinc-400">Every incoming transcription frame is shown with full payload data.</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              onclick={handlePrimaryAction}
              disabled={!canRunPrimaryAction}
              class="px-4 py-2 text-sm font-medium rounded-lg transition-colors
                {canRunPrimaryAction
                  ? recording.isRecording
                    ? 'bg-red-900/60 text-red-200 hover:bg-red-800/70 cursor-pointer'
                    : 'bg-emerald-900/60 text-emerald-200 hover:bg-emerald-800/70 cursor-pointer'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
            >
              {primaryButtonLabel}
            </button>
            <button
              onclick={clearSessions}
              class="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-900 text-zinc-300 hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              Clear Sessions
            </button>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-1 gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
          <div class="mb-3 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-zinc-200">Sessions</h3>
            <span class="text-xs text-zinc-500">{sessions.length}</span>
          </div>

          {#if sessions.length === 0}
            <div class="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 text-sm text-zinc-500">
              Start a session to populate the lab.
            </div>
          {:else}
            <div class="space-y-2 max-h-[540px] overflow-y-auto pr-1">
              {#each sessions as session}
                <button
                  onclick={() => selectSession(session.id)}
                  class="w-full rounded-xl border p-3 text-left transition-colors cursor-pointer
                    {activeSession?.id === session.id
                      ? 'border-zinc-600 bg-zinc-800/80'
                      : 'border-zinc-800 bg-zinc-950/70 hover:bg-zinc-900'}"
                >
                  <div class="mb-1 flex items-center justify-between gap-2">
                    <p class="text-sm font-medium text-zinc-200">Session {session.id}</p>
                    <span class="inline-flex rounded-md border px-2 py-0.5 text-[11px] {badgeClass(session.endedAt === null)}">
                      {session.endedAt === null ? 'active' : 'done'}
                    </span>
                  </div>
                  <p class="text-xs text-zinc-500">{formatClock(session.startedAt)} - {formatDuration(getSessionDurationMs(session))}</p>
                  <p class="mt-1 text-xs text-zinc-400">
                    Frames {session.frames.length} - Finals {session.finalCount}
                  </p>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="space-y-4">
          <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <h3 class="text-sm font-semibold text-zinc-200 mb-3">Live state</h3>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div class="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                <p class="text-xs text-zinc-500 mb-2 uppercase tracking-wide">Recording</p>
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
                <p class="text-xs text-zinc-500 mb-2 uppercase tracking-wide">Mode</p>
                <p class="text-sm text-zinc-200">{settings?.holdToTalk ? 'Hold-to-talk' : 'Toggle-to-talk'}</p>
              </div>
              <div class="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                <p class="text-xs text-zinc-500 mb-2 uppercase tracking-wide">Device</p>
                <p class="text-sm text-zinc-200 font-mono truncate" title={settings?.selectedDeviceId ?? 'default'}>
                  {settings?.selectedDeviceId ?? 'default'}
                </p>
              </div>
            </div>
            {#if connection.error}
              <p class="mt-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {connection.error}
              </p>
            {/if}
          </div>

          {#if activeSession}
            <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 class="text-sm font-semibold text-zinc-200">Session {activeSession.id}</h3>
                  <p class="text-xs text-zinc-500">Started {formatClock(activeSession.startedAt)}</p>
                </div>
                <div class="flex items-center gap-2">
                  <span class="inline-flex rounded-md border px-2.5 py-1 text-xs {recordingStateClass(activeSession.recordingState)}">
                    {activeSession.recordingState}
                  </span>
                  <span class="inline-flex rounded-md border px-2.5 py-1 text-xs {connectionStateClass(activeSession.connectionState)}">
                    {activeSession.connectionState}
                  </span>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div class="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-zinc-400">
                  Duration: <span class="text-zinc-200">{formatDuration(getSessionDurationMs(activeSession))}</span>
                </div>
                <div class="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-zinc-400">
                  Frames: <span class="text-zinc-200">{activeSession.frames.length}</span>
                </div>
                <div class="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-zinc-400">
                  Finals: <span class="text-zinc-200">{activeSession.finalCount}</span>
                </div>
                <div class="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-zinc-400">
                  Events: <span class="text-zinc-200">{activeSession.events.length}</span>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div class="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3">
                  <div class="mb-2 flex items-center justify-between">
                    <p class="text-xs uppercase tracking-wide text-zinc-500">Latest final</p>
                    <button
                      onclick={copySelectedFinal}
                      disabled={!activeSession.latestFinal}
                      class="px-2.5 py-1 text-xs rounded-md transition-colors
                        {activeSession.latestFinal
                          ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 cursor-pointer'
                          : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
                    >
                      Copy
                    </button>
                  </div>
                  {#if activeSession.latestFinal}
                    <p class="text-sm text-zinc-200 whitespace-pre-wrap break-words">{activeSession.latestFinal}</p>
                  {:else}
                    <p class="text-sm text-zinc-500 italic">No final yet</p>
                  {/if}
                </div>
                <div class="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3">
                  <p class="mb-2 text-xs uppercase tracking-wide text-zinc-500">Current partial</p>
                  <p class="text-sm text-zinc-300 whitespace-pre-wrap break-words">
                    {activeSession.latestPartial || '-'}
                  </p>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div class="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3">
                  <h4 class="text-sm font-medium text-zinc-200 mb-2">Transcription frames (all payload data)</h4>
                  <div class="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                    {#if activeSession.frames.length === 0}
                      <p class="text-sm text-zinc-500">No frames received yet</p>
                    {:else}
                      {#each activeSession.frames as frame}
                        <div class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5">
                          <p class="text-[11px] text-zinc-500">
                            {formatClock(frame.timestamp)} - type={frame.payload.type} - confidence={Math.round(frame.payload.confidence * 100)}%
                          </p>
                          <p class="mt-1 text-xs text-zinc-200 whitespace-pre-wrap break-words">
                            {frame.payload.text || '[empty text]'}
                          </p>
                          <pre class="mt-2 rounded bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-400 overflow-x-auto">{JSON.stringify(frame.payload, null, 2)}</pre>
                        </div>
                      {/each}
                    {/if}
                  </div>
                </div>

                <div class="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3">
                  <h4 class="text-sm font-medium text-zinc-200 mb-2">Session events</h4>
                  <div class="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                    {#if activeSession.events.length === 0}
                      <p class="text-sm text-zinc-500">No events yet</p>
                    {:else}
                      {#each activeSession.events as event}
                        <div class="rounded-lg border px-2.5 py-2 {toneClass(event.tone)}">
                          <div class="flex items-center justify-between gap-2">
                            <p class="text-sm text-zinc-200">{event.message}</p>
                            <span class="text-xs font-mono text-zinc-500">{formatClock(event.timestamp)}</span>
                          </div>
                          <p class="mt-1 text-xs text-zinc-400 whitespace-pre-wrap break-words">{event.detail}</p>
                        </div>
                      {/each}
                    {/if}
                  </div>
                </div>
              </div>
            </div>
          {:else}
            <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center text-sm text-zinc-500">
              No session selected.
            </div>
          {/if}
        </div>
      </section>

      <section class="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 class="text-sm font-semibold text-zinc-200 mb-2">What this lab shows</h3>
        <p class="text-sm text-zinc-400">
          Every transcription payload from the active session is displayed in full. Nothing is deduplicated or trimmed.
        </p>
      </section>
    </div>
  </div>
</div>
