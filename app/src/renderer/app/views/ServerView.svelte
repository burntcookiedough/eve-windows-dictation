<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import ModelProgressCard from '../components/ModelProgressCard.svelte';
  import type { ServerStatePayload, ServerLogEntry } from '$shared/types';
  import { shouldShowModelProgress } from '$shared/model-progress';
  import { serverStatusState } from '../server-status';

  interface Props {
    embedded?: boolean;
    externalMode?: boolean;
  }

  let { embedded = false, externalMode: externalModeProp }: Props = $props();
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
  let showLogs = $state(false);
  let autoStart = $state(true);
  let configuredExternalServer = $state(false);
  let isLoading = $state(false);
  let logsContainer: HTMLDivElement | null = $state(null);
  let logsCopied = $state(false);
  let diagnosticsCopyState = $state<'idle' | 'copied' | 'error'>('idle');
  let diagnosticsCopyTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingLogs: ServerLogEntry[] = [];
  let logFrame: number | null = null;
  let scrollAfterLogBatch = false;
  let removeLogListener: (() => void) | null = null;

  let externalMode = $derived(externalModeProp ?? configuredExternalServer);
  const logOutputId = `server-log-output-${componentId}`;
  const privacyWarningId = `server-logs-privacy-${componentId}`;

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
    !externalMode &&
    !isLoading &&
    (serverState.status === 'stopped' || serverState.status === 'idle' || serverState.status === 'error')
  );
  let canStop = $derived(
    !externalMode &&
    !isLoading && serverState.managed && serverState.status === 'running'
  );
  let canRestart = $derived(
    !externalMode &&
    !isLoading && serverState.managed && serverState.status === 'running'
  );
  let canShutdownManaged = $derived(
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
    const text = logs
      .map((log) => `${formatLogTime(log.timestamp)} ${log.message}`)
      .join('\n');
    window.murmurMain.copyToClipboard(text);
    logsCopied = true;
    setTimeout(() => (logsCopied = false), 2000);
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
    if (pendingLogs.length > 500) pendingLogs = pendingLogs.slice(-500);
    if (logFrame !== null) return;

    logFrame = requestAnimationFrame(() => {
      logFrame = null;
      const nextLogs = pendingLogs;
      pendingLogs = [];
      logs = [...logs, ...nextLogs].slice(-500);
      if (scrollAfterLogBatch) {
        scrollAfterLogBatch = false;
        requestAnimationFrame(scrollLogsToBottom);
      }
    });
  }

  onMount(() => {
    let active = true;

    async function load(): Promise<void> {
      const initialLogs = await window.murmurMain.getServerLogs();
      if (!active) return;
      logs = initialLogs;

      const settings = await window.murmurMain.getSettings();
      if (!active) return;
      autoStart = settings.serverAutoStart;
      configuredExternalServer = settings.useExternalServer;

      if (!active) return;
      removeLogListener = window.murmurMain.onServerLog((entry) => {
        queueLog(entry);
      });
    }

    void load();
    return () => {
      active = false;
    };
  });

  onDestroy(() => {
    if (logFrame !== null) cancelAnimationFrame(logFrame);
    if (diagnosticsCopyTimer !== null) clearTimeout(diagnosticsCopyTimer);
    removeLogListener?.();
    removeLogListener = null;
  });
</script>

<div data-server-view class={embedded ? 'min-w-0 space-y-6' : 'h-full min-h-0 min-w-0 space-y-6 overflow-y-auto overscroll-contain p-4 pr-3'}>
  {#if externalMode}
    <div data-server-external-notice class="flex min-w-0 flex-col gap-3 rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <p class="text-sm text-amber-200">External server mode is enabled</p>
        <p class="mt-1 text-xs leading-5 text-amber-300/80 [overflow-wrap:anywhere]">
          Built-in server controls are disabled. Configure the external endpoint in Settings &gt; Server &amp; diagnostics.
        </p>
      </div>
      {#if serverState.managed && serverState.status === 'running'}
        <button
          type="button"
          onclick={handleStop}
          disabled={!canShutdownManaged}
          class="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-red-800/70 bg-red-900/60 px-3 py-2 text-xs font-medium text-red-100 transition-colors
            {canShutdownManaged ? 'cursor-pointer hover:bg-red-900' : 'cursor-not-allowed opacity-60'}"
        >
          Shut down built-in server
        </button>
      {/if}
    </div>
  {/if}

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
        class="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
      >
        {diagnosticsCopyState === 'copied'
          ? 'Copied diagnostics'
          : diagnosticsCopyState === 'error'
            ? 'Copy failed'
            : 'Copy diagnostics'}
      </button>
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
          disabled={externalMode}
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
      <div data-server-health-status class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 items-center gap-3" aria-label={`Server status: ${statusDisplay.label}`}>
          <span class="relative flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
            {#if serverState.status === 'running' && engineReady}
              <span class="absolute h-3 w-3 motion-safe:animate-ping rounded-full bg-emerald-400 opacity-75"></span>
            {/if}
            <span class="relative h-3 w-3 rounded-full {statusDisplay.bgColor}"></span>
          </span>
          <span data-server-status class="min-w-0 text-lg font-medium {statusDisplay.color} [overflow-wrap:anywhere]">{statusDisplay.label}</span>
          {#if !serverState.managed && serverState.status === 'running'}
            <span class="shrink-0 rounded-full border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300">External</span>
          {/if}
        </div>

        <div class="flex min-w-0 flex-wrap items-center gap-2">
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

      {#if externalMode}
        <p data-server-action-restriction class="mt-3 border-t border-white/[0.08] pt-3 text-xs leading-5 text-zinc-500">Start, restart, and stop are unavailable while an external endpoint is active.</p>
      {/if}

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

      {#if serverState.status === 'running' && (serverState.pid || serverState.port || serverState.uptime)}
        <div class="mt-4 grid grid-cols-1 gap-3 border-t border-white/[0.08] pt-4 sm:grid-cols-2">
          {#if serverState.port}
            <div class="min-w-0"><p class="text-xs text-zinc-500">Port</p><p class="mt-1 break-all font-mono text-sm text-zinc-300">{serverState.port}</p></div>
          {/if}
          {#if serverState.version}
            <div class="min-w-0"><p class="text-xs text-zinc-500">Version</p><p class="mt-1 break-all font-mono text-sm text-zinc-300">v{serverState.version}</p></div>
          {/if}
          {#if serverState.pid}
            <div class="min-w-0"><p class="text-xs text-zinc-500">PID</p><p class="mt-1 break-all font-mono text-sm text-zinc-300">{serverState.pid}</p></div>
          {/if}
          {#if serverState.uptime !== undefined}
            <div class="min-w-0"><p class="text-xs text-zinc-500">Uptime</p><p class="mt-1 break-all font-mono text-sm text-zinc-300">{formatUptime(serverState.uptime)}</p></div>
          {/if}
        </div>
      {/if}
    </div>
  </section>

  <section data-server-section="logs" class="min-w-0 space-y-2" aria-labelledby={headingId('logs')}>
    <div class="min-w-0 px-1">
      <svelte:element this={headingTag} id={headingId('logs')} class="text-sm font-semibold text-zinc-200">Logs</svelte:element>
      <p class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">Inspect recent server output only when needed for troubleshooting.</p>
    </div>
    <div data-server-logs-surface class="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-4 focus-within:ring-2 focus-within:ring-zinc-100 focus-within:ring-offset-2 focus-within:ring-offset-[#08090a]">
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
        class="flex min-h-12 w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-zinc-700 bg-zinc-800/70 px-3 py-2 text-left transition-colors hover:bg-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
      >
        <span class="min-w-0 text-sm text-zinc-200 [overflow-wrap:anywhere]">Server logs</span>
        <span class="shrink-0 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs tabular-nums text-zinc-400">{logs.length}</span>
      </button>
      <p id={privacyWarningId} data-server-logs-privacy class="mt-3 text-xs leading-5 text-amber-300/80 [overflow-wrap:anywhere]">Raw logs may contain local paths. Review them before sharing.</p>

      <div id={logOutputId} hidden={!showLogs} class="mt-3 min-w-0">
        <div class="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onclick={copyLogs}
            disabled={logs.length === 0}
            class="inline-flex min-h-9 items-center justify-center gap-1 rounded-lg border border-zinc-700 px-3 py-2 text-xs transition-colors
              {logs.length === 0
                ? 'cursor-not-allowed text-zinc-600'
                : logsCopied
                  ? 'cursor-default text-emerald-400'
                  : 'cursor-pointer text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}"
          >
            {#if logsCopied}Copied{:else}Copy raw logs{/if}
          </button>
        </div>
        <div
          data-server-log-output
          id={`${logOutputId}-scroll`}
          bind:this={logsContainer}
          class="mt-2 max-h-64 min-h-24 min-w-0 overflow-y-auto overscroll-contain rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs"
        >
          {#if logs.length === 0}
            <p class="py-8 text-center text-zinc-500">No logs yet</p>
          {:else}
            {#each logs as log}
              <div class="flex min-w-0 gap-2 py-0.5">
                <span class="shrink-0 text-zinc-500">{formatLogTime(log.timestamp)}</span>
                <span class="min-w-0 break-all {log.level === 'stderr' ? 'text-red-300' : 'text-zinc-300'}">{log.message}</span>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  </section>
</div>
