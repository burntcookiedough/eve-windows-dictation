<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import ModelProgressCard from '../components/ModelProgressCard.svelte';
  import type { ServerStatePayload, ServerLogEntry, Settings } from '$shared/types';
  import { shouldShowModelProgress } from '$shared/model-progress';

  // Server state
  let serverState = $state<ServerStatePayload>({
    status: 'idle',
    managed: false,
  });
  let logs = $state<ServerLogEntry[]>([]);
  let showLogs = $state(false);
  let autoStart = $state(true);
  let useExternalServer = $state(false);
  let isLoading = $state(false);
  let logsContainer: HTMLDivElement | null = $state(null);
  let logsCopied = $state(false);
  let pendingLogs: ServerLogEntry[] = [];
  let logFrame: number | null = null;
  let scrollAfterLogBatch = false;

  // Status badge colors and labels
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

  // Format uptime as human-readable string
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

  // Format timestamp for logs
  function formatLogTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour12: false });
  }

  // Can start/stop based on status and management mode
  let canStart = $derived(
    !useExternalServer &&
    !isLoading &&
    (serverState.status === 'stopped' || serverState.status === 'idle' || serverState.status === 'error')
  );
  let canStop = $derived(
    !useExternalServer &&
    !isLoading && serverState.managed && serverState.status === 'running'
  );
  let canRestart = $derived(
    !useExternalServer &&
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
    const threshold = 40; // px from bottom to consider "at bottom"
    return logsContainer.scrollHeight - logsContainer.scrollTop - logsContainer.clientHeight < threshold;
  }

  function scrollLogsToBottom() {
    if (logsContainer) {
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  }

  function copyLogs() {
    const text = logs
      .map((l) => `${formatLogTime(l.timestamp)} ${l.message}`)
      .join('\n');
    window.murmurMain.copyToClipboard(text);
    logsCopied = true;
    setTimeout(() => (logsCopied = false), 2000);
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

  onMount(async () => {
    // Load initial state
    serverState = await window.murmurMain.getServerStatus();
    logs = await window.murmurMain.getServerLogs();

    // Load settings
    const settings = await window.murmurMain.getSettings();
    autoStart = settings.serverAutoStart;
    useExternalServer = settings.useExternalServer;

    // Subscribe to state changes
    window.murmurMain.onServerStateChange((state) => {
      serverState = state;
    });

    window.murmurMain.onServerLog((entry) => {
      queueLog(entry);
    });
  });

  onDestroy(() => {
    if (logFrame !== null) cancelAnimationFrame(logFrame);
    window.murmurMain.removeServerListeners();
  });
</script>

<div class="h-full p-6 pr-2">
  <div class="h-full overflow-y-auto pr-4">
    <div class="space-y-8">

    {#if useExternalServer}
      <div class="rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-sm text-amber-200">External server mode is enabled</p>
            <p class="mt-1 text-xs text-amber-300/80">
              Managed server controls are disabled. Configure host and port in Settings > Server.
            </p>
          </div>
          {#if serverState.managed && serverState.status === 'running'}
            <button
              onclick={handleStop}
              disabled={!canShutdownManaged}
              class="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
                {canShutdownManaged
                  ? 'bg-red-900/60 hover:bg-red-900 text-red-100 cursor-pointer'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
            >
              Shut down server
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <div class="space-y-8 {useExternalServer ? 'opacity-45 pointer-events-none select-none' : ''}">

    <!-- Status Card -->
    <SettingsSection title="Status">
      <div class="p-4 bg-zinc-900/50 rounded-xl w-full">
        <div class="flex items-center justify-between mb-4">
          <!-- Status Badge -->
          <div class="flex items-center gap-3">
            <div class="relative flex items-center justify-center">
              {#if serverState.status === 'running' && engineReady}
                <!-- Pulse animation for running state -->
                <span class="absolute w-3 h-3 rounded-full bg-emerald-400 animate-ping opacity-75"></span>
              {/if}
              <span class="relative w-3 h-3 rounded-full {statusDisplay.bgColor}"></span>
            </div>
            <span class="text-lg font-medium {statusDisplay.color}">
              {statusDisplay.label}
            </span>
            {#if !serverState.managed && serverState.status === 'running'}
              <span class="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
                External
              </span>
            {/if}
          </div>

          <!-- Control Buttons -->
          <div class="flex items-center gap-2">
            {#if serverState.status === 'running'}
              <button
                onclick={handleRestart}
                disabled={!canRestart}
                class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
                  {canRestart
                    ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200 cursor-pointer'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
              >
                Restart
              </button>
              <button
                onclick={handleStop}
                disabled={!canStop}
                class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
                  {canStop
                    ? 'bg-red-900/50 hover:bg-red-900 text-red-200 cursor-pointer'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
              >
                Stop
              </button>
            {:else}
              <button
                onclick={handleStart}
                disabled={!canStart}
                class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
                  {canStart
                    ? 'bg-emerald-900/50 hover:bg-emerald-900 text-emerald-200 cursor-pointer'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
              >
                {isLoading ? 'Starting...' : 'Start'}
              </button>
            {/if}
          </div>
        </div>

        <!-- Error Message -->
        {#if serverState.error}
          <div class="mb-4 p-3 bg-red-950/50 border border-red-900/50 rounded-lg">
            <p class="text-sm text-red-300">{serverState.error}</p>
          </div>
        {/if}

        {#if serverState.engineStatus?.status === 'error'}
          <div class="mb-4 rounded-lg border border-red-900/60 bg-red-950/30 p-3">
            <p class="text-sm text-red-300">Transcription engine failed to load</p>
            <p class="mt-1 text-xs text-red-300/80">
              {serverState.engineStatus.message ?? 'Restart the server or select a CPU-compatible engine configuration.'}
            </p>
          </div>
        {/if}

        {#if modelDownload && showModelProgress}
          <div class="mx-auto mb-4 max-w-2xl">
            <ModelProgressCard state={modelDownload} />
          </div>
        {/if}

        {#if modelDownloadError}
          <div class="mb-4 rounded-lg border border-red-900/60 bg-red-950/30 p-3">
            <p class="text-sm text-red-300">
              Model download failed
              {#if modelDownload?.model}
                <span class="text-red-300/80">({modelDownload.model})</span>
              {/if}
            </p>
            <p class="mt-1 text-xs text-red-300/80">
              {modelDownload?.detail ?? 'Check your connection and restart the server to retry.'}
            </p>
          </div>
        {/if}

        {#if diagnosticWarnings.length > 0}
          <div class="mb-4 space-y-2">
            {#each diagnosticWarnings as warning}
              <div class="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3">
                <p class="text-sm text-amber-200">{warning.message}</p>
                {#if warning.action || warning.url}
                  <div class="mt-2 text-xs text-amber-300/80 flex flex-wrap items-center gap-2">
                    {#if warning.action}
                      <span>{warning.action}</span>
                    {/if}
                    {#if warning.url}
                      <a
                        href={warning.url}
                        target="_blank"
                        rel="noreferrer"
                        class="underline underline-offset-2 hover:text-amber-200 cursor-pointer"
                      >
                        Open link
                      </a>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <!-- Details Grid (when running) -->
        {#if serverState.status === 'running' && (serverState.pid || serverState.port || serverState.uptime)}
          <div class="grid grid-cols-2 gap-4 pt-4 border-t border-zinc-800">
            {#if serverState.port}
              <div>
                <p class="text-xs text-zinc-500 mb-1">Port</p>
                <p class="text-sm font-mono text-zinc-300">{serverState.port}</p>
              </div>
            {/if}
            {#if serverState.version}
              <div>
                <p class="text-xs text-zinc-500 mb-1">Version</p>
                <p class="text-sm font-mono text-zinc-300">v{serverState.version}</p>
              </div>
            {/if}
            {#if serverState.pid}
              <div>
                <p class="text-xs text-zinc-500 mb-1">PID</p>
                <p class="text-sm font-mono text-zinc-300">{serverState.pid}</p>
              </div>
            {/if}
            {#if serverState.uptime !== undefined}
              <div>
                <p class="text-xs text-zinc-500 mb-1">Uptime</p>
                <p class="text-sm font-mono text-zinc-300">{formatUptime(serverState.uptime)}</p>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </SettingsSection>

    <!-- Settings -->
    <SettingsSection title="Settings">
      <SettingsRow label="Auto-start server" description="Automatically start the server when the app launches">
        <Toggle
          enabled={autoStart}
          onchange={updateAutoStart}
          label="Auto-start server"
        />
      </SettingsRow>
    </SettingsSection>

    <!-- Logs -->
    <SettingsSection title="Logs">
      <div class="w-full">
        <button
          onclick={() => {
            showLogs = !showLogs;
            if (showLogs) {
              setTimeout(scrollLogsToBottom, 0);
            }
          }}
          class="w-full flex items-center justify-between p-4 bg-zinc-900/50 rounded-xl hover:bg-zinc-900 transition-colors cursor-pointer"
        >
          <div class="flex items-center gap-2">
            <span class="text-sm text-zinc-200">Server Logs</span>
            <span class="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
              {logs.length}
            </span>
          </div>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-zinc-400 transition-transform duration-200 {showLogs ? 'rotate-180' : ''}"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>

        {#if showLogs}
          <div class="mt-2 flex items-center justify-end px-1">
            <button
              onclick={(e: MouseEvent) => { e.stopPropagation(); copyLogs(); }}
              disabled={logs.length === 0}
              class="flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors
                {logs.length === 0
                  ? 'text-zinc-600 cursor-not-allowed'
                  : logsCopied
                    ? 'text-emerald-400 cursor-default'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer'}"
            >
              {#if logsCopied}
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                Copied
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                Copy
              {/if}
            </button>
          </div>
          <div
            bind:this={logsContainer}
            class="mt-1 h-64 overflow-y-auto bg-zinc-950 rounded-xl border border-zinc-800 p-3 font-mono text-xs"
          >
            {#if logs.length === 0}
              <p class="text-zinc-500 text-center py-8">No logs yet</p>
            {:else}
              {#each logs as log}
                <div class="flex gap-2 py-0.5 hover:bg-zinc-900/50">
                  <span class="text-zinc-600 shrink-0">{formatLogTime(log.timestamp)}</span>
                  <span class="{log.level === 'stderr' ? 'text-red-400' : 'text-zinc-300'} break-all">
                    {log.message}
                  </span>
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </SettingsSection>

    </div>

    </div>
  </div>
</div>
