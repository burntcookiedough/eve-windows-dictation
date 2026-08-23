<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import ModelProgressCard from '../components/ModelProgressCard.svelte';
  import type { ServerStatePayload, ServerLogEntry } from '$shared/types';
  import { shouldShowModelProgress } from '$shared/model-progress';
  import { serverStatusState } from '../server-status';
  import {
    getServerLogBodySize,
    getServerLogCountLabel,
    MAX_SERVER_LOG_ENTRIES,
    SERVER_LOG_LOAD_ERROR,
    type ServerLogLoadState,
  } from '../server-log';

  interface Props {
    embedded?: boolean;
  }

  let { embedded = false }: Props = $props();
  const componentId = $props.id();
  const headingTag = $derived(embedded ? 'h3' : 'h2');

  function headingId(slug: string): string {
    return `server-${slug}-${componentId}`;
  }

  const unavailableState: ServerStatePayload = {
    status: 'idle',
    managed: false,
  };

  let serverState = $derived($serverStatusState.state ?? unavailableState);
  let logs = $state<ServerLogEntry[]>([]);
  let logsLoadState = $state<ServerLogLoadState>('loading');
  let showLogs = $state(false);
  let autoStart = $state(true);
  let isLoading = $state(false);
  let logsContainer: HTMLDivElement | null = $state(null);
  let logsCopied = $state(false);
  let logsCopiedTimer: ReturnType<typeof setTimeout> | null = null;
  let diagnosticsCopyState = $state<'idle' | 'copied' | 'error'>('idle');
  let diagnosticsCopyTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingLogs: ServerLogEntry[] = [];
  let logFrame: number | null = null;
  let scrollAfterLogBatch = false;
  let removeLogListener: (() => void) | null = null;
  let reloadLogs: (() => Promise<void>) | null = null;

  const logOutputId = `server-log-output-${componentId}`;
  const privacyWarningId = `server-logs-privacy-${componentId}`;
  const diagnosticsStatusId = `server-diagnostics-status-${componentId}`;

  const statusConfig: Record<
    ServerStatePayload['status'],
    { color: string; bgColor: string; label: string }
  > = {
    idle: { color: 'text-zinc-400', bgColor: 'bg-zinc-700', label: 'Idle' },
    starting: { color: 'text-amber-400', bgColor: 'bg-amber-900/50', label: 'Starting' },
    running: { color: 'text-emerald-400', bgColor: 'bg-emerald-900/50', label: 'Running' },
    stopping: { color: 'text-amber-400', bgColor: 'bg-amber-900/50', label: 'Stopping' },
    stopped: { color: 'text-zinc-400', bgColor: 'bg-zinc-700', label: 'Stopped' },
    error: { color: 'text-red-400', bgColor: 'bg-red-900/50', label: 'Error' },
  };

  let statusDisplay = $derived(
    serverState.status === 'running' && serverState.engineStatus?.status === 'loading'
      ? { color: 'text-amber-400', bgColor: 'bg-amber-400', label: 'Loading engine' }
      : serverState.status === 'running' && serverState.engineStatus?.status === 'error'
        ? { color: 'text-red-400', bgColor: 'bg-red-400', label: 'Engine error' }
        : statusConfig[serverState.status]
  );
  let engineReady = $derived(serverState.engineStatus?.status === 'ready');
  let diagnosticWarnings = $derived(serverState.diagnostics?.warnings ?? []);
  let modelDownload = $derived(serverState.modelDownload);
  let showModelProgress = $derived(shouldShowModelProgress(modelDownload));
  let modelDownloadError = $derived(modelDownload?.status === 'error');
  let logBodySize = $derived(getServerLogBodySize(logsLoadState, logs.length));
  let logCountLabel = $derived(getServerLogCountLabel(logsLoadState, logs.length));

  function formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  function formatLogTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour12: false });
  }

  let canStart = $derived(
    !isLoading &&
    (serverState.status === 'stopped' || serverState.status === 'idle' || serverState.status === 'error')
  );
  let canStop = $derived(
    !isLoading && serverState.managed && serverState.status === 'running'
  );
  let canRestart = $derived(
    !isLoading && serverState.managed && serverState.status === 'running'
  );

  async function handleStart() {
    if (!canStart) return;
    isLoading = true;
    try {
      await window.murmurMain.startServer();
    } catch (error) {
      console.error('Failed to start server:', error);
    } finally {
      isLoading = false;
    }
  }

  async function handleStop() {
    if (!canStop) return;
    isLoading = true;
    try {
      await window.murmurMain.stopServer();
    } catch (error) {
      console.error('Failed to stop server:', error);
    } finally {
      isLoading = false;
    }
  }

  async function handleRestart() {
    if (!canRestart) return;
    isLoading = true;
    try {
      await window.murmurMain.restartServer();
    } catch (error) {
      console.error('Failed to restart server:', error);
    } finally {
      isLoading = false;
    }
  }

  function updateAutoStart(enabled: boolean) {
    autoStart = enabled;
    window.murmurMain.updateSetting('serverAutoStart', enabled);
  }

  function isScrolledToBottom(): boolean {
    if (!logsContainer) return true;
    const threshold = 40;
    return logsContainer.scrollHeight - logsContainer.scrollTop - logsContainer.clientHeight < threshold;
  }

  function scrollLogsToBottom() {
    if (logsContainer) logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  function copyLogs() {
    if (logsLoadState !== 'ready' || logs.length === 0) return;

    const text = logs
      .map((log) => `${formatLogTime(log.timestamp)} ${log.message}`)
      .join('\n');
    window.murmurMain.copyToClipboard(text);
    logsCopied = true;
    if (logsCopiedTimer !== null) clearTimeout(logsCopiedTimer);
    logsCopiedTimer = setTimeout(() => {
      logsCopied = false;
      logsCopiedTimer = null;
    }, 2000);
  }

  async function copyDiagnostics() {
    if (diagnosticsCopyTimer !== null) clearTimeout(diagnosticsCopyTimer);
    diagnosticsCopyState = 'idle';
    try {
      await window.murmurMain.copyDiagnostics();
      diagnosticsCopyState = 'copied';
    } catch {
      diagnosticsCopyState = 'error';
    }
    diagnosticsCopyTimer = setTimeout(() => {
      diagnosticsCopyState = 'idle';
      diagnosticsCopyTimer = null;
    }, 2000);
  }

  function queueLog(entry: ServerLogEntry) {
    scrollAfterLogBatch ||= showLogs && isScrolledToBottom();
    pendingLogs.push(entry);
    if (pendingLogs.length > MAX_SERVER_LOG_ENTRIES) pendingLogs = pendingLogs.slice(-MAX_SERVER_LOG_ENTRIES);
    if (logFrame !== null) return;

    logFrame = requestAnimationFrame(() => {
      logFrame = null;
      const nextLogs = pendingLogs;
      pendingLogs = [];
      logs = [...logs, ...nextLogs].slice(-MAX_SERVER_LOG_ENTRIES);
      logsLoadState = 'ready';
      if (scrollAfterLogBatch) {
        scrollAfterLogBatch = false;
        requestAnimationFrame(scrollLogsToBottom);
      }
    });
  }

  async function retryLogs(): Promise<void> {
    if (logsLoadState === 'loading') return;
    await reloadLogs?.();
  }

  onMount(() => {
    let active = true;

    const loadLogs = async (): Promise<void> => {
      const shouldScroll = showLogs && isScrolledToBottom();
      logsLoadState = 'loading';

      try {
        const initialLogs = await window.murmurMain.getServerLogs();
        if (!active) return;
        logs = initialLogs.slice(-MAX_SERVER_LOG_ENTRIES);
        logsLoadState = 'ready';
        if (shouldScroll) requestAnimationFrame(scrollLogsToBottom);
      } catch (error) {
        console.error('Failed to load server logs:', error);
        if (!active) return;
        logs = [];
        logsLoadState = 'error';
      }
    };

    reloadLogs = loadLogs;

    async function load(): Promise<void> {
      await loadLogs();
      if (!active) return;

      const settings = await window.murmurMain.getSettings();
      if (!active) return;
      autoStart = settings.serverAutoStart;

      if (!active || removeLogListener) return;
      removeLogListener = window.murmurMain.onServerLog((entry) => {
        queueLog(entry);
      });
    }

    void load();
    return () => {
      active = false;
      reloadLogs = null;
    };
  });

  onDestroy(() => {
    if (logFrame !== null) cancelAnimationFrame(logFrame);
    if (logsCopiedTimer !== null) clearTimeout(logsCopiedTimer);
    if (diagnosticsCopyTimer !== null) clearTimeout(diagnosticsCopyTimer);
    removeLogListener?.();
    removeLogListener = null;
    reloadLogs = null;
  });
</script>

<div data-server-view class={embedded ? 'min-w-0 space-y-6' : 'h-full min-h-0 min-w-0 space-y-6 overflow-y-auto overscroll-contain p-4 pr-3'}>
  <section data-server-section="diagnostics" class="min-w-0 space-y-2" aria-labelledby={headingId('diagnostics')}>
    <div class="min-w-0 px-1">
      <svelte:element this={headingTag} id={headingId('diagnostics')} class="text-sm font-semibold text-zinc-200">Diagnostics</svelte:element>
      <p class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">Copy an allowlisted system summary without logs, paths, history, or transcription text.</p>
    </div>
    <div data-server-diagnostics-surface class="flex min-w-0 flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:flex-row sm:items-center sm:justify-between">
      <p class="min-w-0 text-xs leading-5 text-zinc-400 [overflow-wrap:anywhere]">Diagnostics include only the information Eve needs to explain server readiness and compatibility.</p>
      <button
        type="button"
        onclick={copyDiagnostics}
        aria-describedby={diagnosticsStatusId}
        class="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
      >
        Copy diagnostics
      </button>
      <span id={diagnosticsStatusId} class="sr-only">
        {diagnosticsCopyState === 'copied'
          ? 'Diagnostics copied.'
          : diagnosticsCopyState === 'error'
            ? 'Diagnostics copy failed.'
            : ''}
      </span>
    </div>
  </section>

  <section data-server-section="management" class="min-w-0 space-y-2" aria-labelledby={headingId('management')}>
    <div class="min-w-0 px-1">
      <svelte:element this={headingTag} id={headingId('management')} class="text-sm font-semibold text-zinc-200">Server management</svelte:element>
      <p class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">Control the built-in server lifecycle and startup behavior.</p>
    </div>
    <div data-server-management-surface class="min-w-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
      <SettingsRow label="Auto-start server" description="Automatically start the built-in server when Eve launches">
        <Toggle
          enabled={autoStart}
          onchange={updateAutoStart}
          label="Auto-start server"
        />
      </SettingsRow>
    </div>
  </section>

  <section data-server-section="health" class="min-w-0 space-y-2" aria-labelledby={headingId('health')}>
    <div class="min-w-0 px-1">
      <svelte:element this={headingTag} id={headingId('health')} class="text-sm font-semibold text-zinc-200">Health &amp; actions</svelte:element>
      <p class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">Live status from the shared server controller; lifecycle actions apply only to the managed server.</p>
    </div>
    <div data-server-health-surface class="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <div data-server-health-status class="grid min-w-0 gap-4 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center">
        <div class="flex min-w-0 items-center gap-3">
          <span class="relative flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
            {#if serverState.status === 'running' && engineReady}
              <span class="absolute h-3 w-3 motion-safe:animate-ping rounded-full bg-emerald-400 opacity-75"></span>
            {/if}
            <span class="relative h-3 w-3 rounded-full {statusDisplay.bgColor}"></span>
          </span>
          <span data-server-status class="min-w-0 text-lg font-medium {statusDisplay.color} [overflow-wrap:anywhere]">{statusDisplay.label}</span>
        </div>

        {#if serverState.status === 'running' && (serverState.pid !== undefined || serverState.port !== undefined || serverState.version !== undefined || serverState.uptime !== undefined)}
          <dl data-server-health-details class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 md:justify-center">
            {#if serverState.port}
              <div class="flex min-w-0 items-baseline gap-1.5"><dt class="text-[11px] text-zinc-500">Port</dt><dd class="break-all font-mono text-xs text-zinc-300">{serverState.port}</dd></div>
            {/if}
            {#if serverState.version}
              <div class="flex min-w-0 items-baseline gap-1.5"><dt class="text-[11px] text-zinc-500">Version</dt><dd class="break-all font-mono text-xs text-zinc-300">v{serverState.version}</dd></div>
            {/if}
            {#if serverState.pid}
              <div class="flex min-w-0 items-baseline gap-1.5"><dt class="text-[11px] text-zinc-500">PID</dt><dd class="break-all font-mono text-xs text-zinc-300">{serverState.pid}</dd></div>
            {/if}
            {#if serverState.uptime !== undefined}
              <div class="flex min-w-0 items-baseline gap-1.5"><dt class="text-[11px] text-zinc-500">Uptime</dt><dd class="break-all font-mono text-xs text-zinc-300">{formatUptime(serverState.uptime)}</dd></div>
            {/if}
          </dl>
        {:else}
          <div class="hidden md:block"></div>
        {/if}

        <div class="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
          {#if serverState.status === 'running'}
            <button
              type="button"
              onclick={handleRestart}
              disabled={!canRestart}
              class="inline-flex min-h-9 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors
                {canRestart ? 'cursor-pointer hover:bg-zinc-700' : 'cursor-not-allowed opacity-60'}"
            >
              Restart
            </button>
            <button
              type="button"
              onclick={handleStop}
              disabled={!canStop}
              class="inline-flex min-h-9 items-center justify-center rounded-lg border border-red-800/70 bg-red-900/50 px-3 py-2 text-xs font-medium text-red-200 transition-colors
                {canStop ? 'cursor-pointer hover:bg-red-900' : 'cursor-not-allowed opacity-60'}"
            >
              Stop
            </button>
          {:else}
            <button
              type="button"
              onclick={handleStart}
              disabled={!canStart}
              class="inline-flex min-h-9 items-center justify-center rounded-lg border border-emerald-800/70 bg-emerald-900/50 px-3 py-2 text-xs font-medium text-emerald-200 transition-colors
                {canStart ? 'cursor-pointer hover:bg-emerald-900' : 'cursor-not-allowed opacity-60'}"
            >
              {isLoading ? 'Starting…' : 'Start'}
            </button>
          {/if}
        </div>
      </div>

      {#if serverState.error}
        <div class="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 p-3">
          <p class="text-sm text-red-300 [overflow-wrap:anywhere]">{serverState.error}</p>
        </div>
      {/if}

      {#if serverState.engineStatus?.status === 'error'}
        <div class="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 p-3">
          <p class="text-sm text-red-300">Transcription engine failed to load</p>
          <p class="mt-1 text-xs leading-5 text-red-300/80 [overflow-wrap:anywhere]">
            {serverState.engineStatus.message ?? 'Restart the server or select a CPU-compatible engine configuration.'}
          </p>
        </div>
      {/if}

      {#if modelDownload && showModelProgress}
        <div class="mx-auto mt-4 max-w-2xl">
          <ModelProgressCard state={modelDownload} announce={false} />
        </div>
      {/if}

      {#if modelDownloadError}
        <div class="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 p-3">
          <p class="text-sm text-red-300">
            Model download failed
            {#if modelDownload?.model}
              <span class="text-red-300/80 [overflow-wrap:anywhere]">({modelDownload.model})</span>
            {/if}
          </p>
          <p class="mt-1 text-xs leading-5 text-red-300/80 [overflow-wrap:anywhere]">
            {modelDownload?.detail ?? 'Check your connection and restart the server to retry.'}
          </p>
        </div>
      {/if}

      {#if diagnosticWarnings.length > 0}
        <div data-server-diagnostic-warnings class="mt-4 space-y-2">
          {#each diagnosticWarnings as warning}
            <div class="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3">
              <p class="text-sm text-amber-200 [overflow-wrap:anywhere]">{warning.message}</p>
              {#if warning.action || warning.url}
                <div class="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-amber-300/80">
                  {#if warning.action}<span class="[overflow-wrap:anywhere]">{warning.action}</span>{/if}
                  {#if warning.url}
                    <a href={warning.url} target="_blank" rel="noreferrer" class="cursor-pointer break-all underline underline-offset-2 hover:text-amber-200">Open link</a>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

    </div>
  </section>

  <section data-server-section="logs" class="min-w-0 space-y-2" aria-labelledby={headingId('logs')}>
    <div class="min-w-0 px-1">
      <svelte:element this={headingTag} id={headingId('logs')} class="text-sm font-semibold text-zinc-200">Logs</svelte:element>
      <p class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">Inspect recent server output only when needed for troubleshooting.</p>
    </div>
    <div data-server-logs-surface class="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <button
        type="button"
        data-server-logs-toggle
        onclick={() => {
          showLogs = !showLogs;
          if (showLogs) setTimeout(scrollLogsToBottom, 0);
        }}
        aria-expanded={showLogs}
        aria-controls={logOutputId}
        aria-describedby={privacyWarningId}
        aria-label={`Server logs, ${logCountLabel}`}
        class="flex min-h-12 w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-zinc-700 bg-zinc-800/70 px-3 py-2 text-left transition-colors hover:bg-zinc-800 cursor-pointer focus:outline focus:outline-2 focus:outline-offset-[-2px] focus:outline-zinc-100"
      >
        <span class="min-w-0 text-sm text-zinc-200 [overflow-wrap:anywhere]">Server logs</span>
        <span data-server-logs-count class="shrink-0 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs tabular-nums text-zinc-400">{logCountLabel}</span>
      </button>
      <p id={privacyWarningId} data-server-logs-privacy class="mt-3 text-xs leading-5 text-amber-300/80 [overflow-wrap:anywhere]">Raw logs may contain local paths. Review them before sharing.</p>

      <div id={logOutputId} hidden={!showLogs} class="mt-3 min-w-0">
        {#if logsLoadState === 'loading'}
          <p data-server-logs-state="loading" data-server-logs-loading role="status" aria-live="polite" class="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-xs text-zinc-400">Loading recent server logs…</p>
        {:else if logsLoadState === 'error'}
          <div data-server-logs-state="error" data-server-logs-error role="alert" class="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-3">
            <p class="min-w-0 text-xs leading-5 text-red-300 [overflow-wrap:anywhere]">{SERVER_LOG_LOAD_ERROR}</p>
            <button
              type="button"
              onclick={retryLogs}
              disabled={logsLoadState === 'loading'}
              class="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Retry
            </button>
          </div>
        {:else if logs.length === 0}
          <p data-server-logs-state="empty" data-server-logs-empty class="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-xs text-zinc-500">No server logs are available yet.</p>
        {/if}

        <div class="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onclick={copyLogs}
            data-server-logs-copy
            aria-describedby={privacyWarningId}
            disabled={logsLoadState !== 'ready' || logs.length === 0}
            class="inline-flex min-h-9 items-center justify-center gap-1 rounded-lg border border-zinc-700 px-3 py-2 text-xs transition-colors focus:outline focus:outline-2 focus:outline-offset-[-2px] focus:outline-zinc-100
              {logsLoadState !== 'ready' || logs.length === 0
                ? 'cursor-not-allowed text-zinc-600'
                : logsCopied
                  ? 'cursor-default text-emerald-400'
                  : 'cursor-pointer text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}"
          >
            {#if logsCopied}Copied{:else}Copy raw logs{/if}
          </button>
        </div>
        {#if logBodySize !== 'empty'}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard focus is required to scroll the bounded log region) -->
          <div
            data-server-log-output
            data-log-size={logBodySize}
            id={`${logOutputId}-scroll`}
            bind:this={logsContainer}
            tabindex="0"
            role="log"
            aria-label="Server log output"
            class={`mt-2 min-w-0 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs focus:outline focus:outline-2 focus:outline-offset-[-2px] focus:outline-zinc-100 ${logBodySize === 'long' ? 'max-h-64 overflow-y-auto overscroll-contain' : 'min-h-16 overflow-hidden'}`}
          >
            {#each logs as log}
              <div class="flex min-w-0 gap-2 py-0.5">
                <span class="shrink-0 text-zinc-500">{formatLogTime(log.timestamp)}</span>
                <span class="min-w-0 break-all {log.level === 'stderr' ? 'text-red-300' : 'text-zinc-300'}">{log.message}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </section>
</div>
