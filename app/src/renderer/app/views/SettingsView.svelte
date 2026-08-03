<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import HotkeyCaptureModal from '../components/HotkeyCaptureModal.svelte';
  import SettingsSkeleton from '../components/SettingsSkeleton.svelte';
  import ServerView from './ServerView.svelte';
  import SpeechModelChooser from '../components/SpeechModelChooser.svelte';
  import { SPEECH_MODEL_PRESETS, presetMatchesReadyEngine, presetPatch, stagedPresetFromPending } from '../speech-model-presets';
  import { getServerManagementMode, serverStatusState } from '../server-status';
  import { serverSettingsStateKey, shouldClearServerSettings, shouldRetryServerSettings } from '../server-settings-recovery';
  import { toast } from '$lib/toast.svelte';
  import { DEFAULT_SETTINGS, type Settings, type Hotkey, type EngineStatus, type ServerSetting } from '$shared/types';
  import { HOTWORDS_WARNING_THRESHOLD, formatHotwordsCsl, parseHotwordsCsl } from '$shared/hotwords';

  const DEFAULT_SERVER_HOST = 'localhost';
  const DEFAULT_SERVER_PORT = 51717;
  const TRANSCRIBE_PATH = '/transcribe';

  // Local settings state - loaded from main process on mount
  let settings = $state<Settings>({
    ...DEFAULT_SETTINGS,
    hotkey: { ...DEFAULT_SETTINGS.hotkey },
    longHotkey: { ...DEFAULT_SETTINGS.longHotkey },
  });

  // Default hotkey (Ctrl+Win on Windows; stored as the libuiohook Meta keycode)
  const DEFAULT_HOTKEY: Hotkey = DEFAULT_SETTINGS.hotkey;

  // Default long dictation hotkey (Ctrl+Shift+Win on Windows)
  const DEFAULT_LONG_HOTKEY: Hotkey = DEFAULT_SETTINGS.longHotkey;

  // Hotkey display name (human-readable)
  let hotkeyDisplayName = $state('Ctrl+Win');
  let longHotkeyDisplayName = $state('Ctrl+Shift+Win');
  let isHotkeyModalOpen = $state(false);
  let hotkeyCaptureTarget = $state<'quick' | 'long'>('quick');

  // Check if hotkey differs from default
  let isHotkeyChanged = $derived(
    settings.hotkey.keycode !== DEFAULT_HOTKEY.keycode ||
    settings.hotkey.ctrlKey !== DEFAULT_HOTKEY.ctrlKey ||
    settings.hotkey.altKey !== DEFAULT_HOTKEY.altKey ||
    settings.hotkey.shiftKey !== DEFAULT_HOTKEY.shiftKey ||
    settings.hotkey.metaKey !== DEFAULT_HOTKEY.metaKey
  );
  let isLongHotkeyChanged = $derived(
    settings.longHotkey.keycode !== DEFAULT_LONG_HOTKEY.keycode ||
    settings.longHotkey.ctrlKey !== DEFAULT_LONG_HOTKEY.ctrlKey ||
    settings.longHotkey.altKey !== DEFAULT_LONG_HOTKEY.altKey ||
    settings.longHotkey.shiftKey !== DEFAULT_LONG_HOTKEY.shiftKey ||
    settings.longHotkey.metaKey !== DEFAULT_LONG_HOTKEY.metaKey
  );

  // Input devices from system enumeration
  let inputDevices = $state<Array<{ id: string; label: string }>>([
    { id: 'default', label: 'Default' },
  ]);
  let isLoadingDevices = $state(true);
  let audioDeviceError = $state('');
  let settingsLoaded = $state(false);
  let appVersion = $state('unknown');
  let hotwordsFileMessage = $state('');
  let externalServerHost = $state(DEFAULT_SERVER_HOST);
  let externalServerPort = $state(String(DEFAULT_SERVER_PORT));
  let externalServerError = $state('');
  let externalServerCard: HTMLDivElement | null = $state(null);

  let hotwordEntries = $derived(parseHotwordsCsl(settings.hotwordsCsl));
  let hotwordCount = $derived(hotwordEntries.length);
  let hasHotwordOverflowWarning = $derived(hotwordCount > HOTWORDS_WARNING_THRESHOLD);

  // Server/engine settings state
  let serverSettings = $state<Record<string, ServerSetting<unknown>> | null>(null);
  let engineStatus = $state<EngineStatus | null>(null);
  let serverConnected = $state(false);
  let serverSettingsLoading = $state(false);
  let lastServerSettingsAttemptKey = $state<string | null>(null);
  let engineAdvancedOpen = $state(false);
  let engineApplying = $state(false);
  let availableEngines = $state<string[]>([]);
  let engineApplyError = $state('');

  // Local engine settings (track pending changes before apply)
  let pendingEngine = $state<Record<string, unknown>>({});
  let sharedServerState = $derived($serverStatusState.state);
  let sharedEngineStatus = $derived(sharedServerState?.engineStatus ?? engineStatus);
  let externalMode = $derived(settings.useExternalServer || getServerManagementMode($serverStatusState) === 'external');

  // Derive current values (server value overridden by pending)
  function getSettingValue<T>(key: string): T | undefined {
    if (key in pendingEngine) return pendingEngine[key] as T;
    const setting = serverSettings?.[key];
    return setting?.value as T | undefined;
  }

  let selectedEngine = $derived(getSettingValue<string>('engine') ?? 'nemotron');
  let selectedPreset = $derived(SPEECH_MODEL_PRESETS.find((preset) =>
    getSettingValue<string>('engine') === preset.engine && getSettingValue<string>(preset.setting) === preset.model
  ) ?? null);
  let stagedPreset = $derived(stagedPresetFromPending(pendingEngine));
  let preparationFailed = $derived(
    !!sharedEngineStatus?.message || sharedEngineStatus?.status === 'error' || sharedEngineStatus?.pending?.status === 'error' ||
    (stagedPreset !== null && sharedServerState?.modelDownload?.model === stagedPreset.model && sharedServerState.modelDownload.status === 'error')
  );

  // Whether the current engine supports hotwords (Whisper: yes, Nemotron: no)
  let hotwordsSupported = $derived(sharedEngineStatus?.info?.supports_hotwords ?? true);

  // Check visibility: should a setting be shown based on visible_when?
  function isVisible(setting: ServerSetting<unknown>): boolean {
    if (!setting.visible_when) return true;
    return Object.entries(setting.visible_when).every(
      ([k, v]) => getSettingValue(k) === v
    );
  }

  // Check if there are pending changes that require engine reload
  function hasPendingReloadChanges(): boolean {
    if (!serverSettings) return false;
    return Object.entries(pendingEngine).some(([key, value]) => {
      const setting = serverSettings![key];
      return setting?.requires_reload && setting.value !== value;
    });
  }

  // Convenience: get options for a select setting
  function getOptions(key: string): Array<{ value: unknown; label: string; description?: string }> {
    return (serverSettings?.[key]?.options as Array<{ value: unknown; label: string; description?: string }>) ?? [];
  }

  function isEngineAvailable(engineId: unknown): boolean {
    if (typeof engineId !== 'string') return true;
    // Backward compatibility with older servers that do not return availability metadata.
    if (availableEngines.length === 0) return true;
    return availableEngines.includes(engineId);
  }

  function formatEstimatedDuration(seconds: number): string {
    if (seconds < 60) {
      return `~${seconds}s`;
    }
    if (seconds < 120) {
      return `~${(seconds / 60).toFixed(1)} min`;
    }
    return `~${Math.round(seconds / 60)} min`;
  }

  function estimatedDurationTooltip(info: NonNullable<EngineStatus['info']>): string {
    const vram = info.gpu_vram_gb != null ? `${info.gpu_vram_gb.toFixed(1)} GB` : 'available';
    return [
      `${info.name} allocates GPU memory proportional to recording length.`,
      `The longer a recording runs, the more VRAM it needs.`,
      ``,
      `This estimate is derived from your GPU's ${vram} total VRAM`,
      `minus the model's base memory footprint, divided by its`,
      `per-second memory growth rate.`,
      ``,
      `Actual limits may vary depending on other GPU workloads.`,
    ].join('\n');
  }

  function parseServerUrl(url: string): { host: string; port: string } {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname || DEFAULT_SERVER_HOST,
        port: parsed.port || String(DEFAULT_SERVER_PORT),
      };
    } catch {
      return {
        host: DEFAULT_SERVER_HOST,
        port: String(DEFAULT_SERVER_PORT),
      };
    }
  }

  function parseHostPaste(input: string): { host: string; port?: string } {
    const trimmed = input.trim();
    if (!trimmed) {
      return { host: '' };
    }

    try {
      const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
        ? trimmed
        : `ws://${trimmed}`;
      const parsed = new URL(withProtocol);
      return {
        host: parsed.hostname,
        port: parsed.port || undefined,
      };
    } catch {
      const hostPortMatch = trimmed.match(/^([^/:\s]+):(\d{1,5})$/);
      if (hostPortMatch) {
        return {
          host: hostPortMatch[1] ?? '',
          port: hostPortMatch[2],
        };
      }
      return { host: trimmed };
    }
  }

  function syncExternalServerFields(url: string): void {
    const parsed = parseServerUrl(url);
    externalServerHost = parsed.host;
    externalServerPort = parsed.port;
  }

  function buildExternalServerUrl(host: string, port: number): string {
    return `ws://${host}:${port}${TRANSCRIBE_PATH}`;
  }

  function updateExternalServerUrl(): void {
    const host = externalServerHost.trim();
    const port = Number(externalServerPort);
    const isValidPort = Number.isInteger(port) && port > 0 && port <= 65535;

    if (!host) {
      externalServerError = 'Host is required';
      return;
    }

    if (!isValidPort) {
      externalServerError = 'Port must be a number between 1 and 65535';
      return;
    }

    externalServerError = '';
    updateSetting('serverUrl', buildExternalServerUrl(host, port));
  }

  async function loadCoreSettings() {
    try {
      const loadedSettings = await window.murmurMain.getSettings();
      settings = loadedSettings;
      syncExternalServerFields(loadedSettings.serverUrl);
      settingsLoaded = true;

      const displayNames = await Promise.allSettled([
        window.murmurMain.getHotkeyDisplayName(loadedSettings.hotkey),
        window.murmurMain.getHotkeyDisplayName(loadedSettings.longHotkey),
      ]);
      if (displayNames[0].status === 'fulfilled') {
        hotkeyDisplayName = displayNames[0].value;
      }
      if (displayNames[1].status === 'fulfilled') {
        longHotkeyDisplayName = displayNames[1].value;
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      settingsLoaded = true;
      toast('Failed to load saved settings', 'error');
    }
  }

  async function loadServerSettings() {
    if (serverSettingsLoading) return;
    serverSettingsLoading = true;
    try {
      const serverData = await window.murmurMain.getServerSettings();
      serverSettings = serverData.settings;
      engineStatus = serverData.engine_status;
      availableEngines = serverData.available_engines ?? [];
      serverConnected = true;
    } catch {
      serverSettings = null;
      engineStatus = null;
      availableEngines = [];
      serverConnected = false;
    } finally {
      serverSettingsLoading = false;
    }
  }

  async function loadAudioDevices() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');

      inputDevices = [
        { id: 'default', label: 'Default' },
        ...audioInputs
          .filter(d => d.deviceId !== 'default') // Avoid duplicate default
          .map(d => ({
            id: d.deviceId,
            label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          })),
      ];
      audioDeviceError = '';
    } catch (err) {
      console.error('Failed to enumerate audio devices:', err);
      const code = err instanceof DOMException ? err.name : '';
      audioDeviceError = code === 'NotAllowedError'
        ? 'Microphone permission is blocked; using the system default input.'
        : 'Microphones could not be listed; using the system default input.';
    } finally {
      isLoadingDevices = false;
    }
  }

  onMount(() => {
    void loadCoreSettings();
    void loadServerSettings();
    void loadAudioDevices();
    void window.murmurMain.getAppVersion()
      .then((version) => (appVersion = version))
      .catch((error) => console.error('Failed to load app version:', error));
  });

  $effect(() => {
    const state = sharedServerState;
    if (shouldClearServerSettings(state, externalMode)) {
      serverSettings = null;
      engineStatus = null;
      availableEngines = [];
      serverConnected = false;
      lastServerSettingsAttemptKey = null;
      return;
    }

    if (shouldRetryServerSettings(state, serverConnected, serverSettingsLoading, lastServerSettingsAttemptKey)) {
      lastServerSettingsAttemptKey = serverSettingsStateKey(state);
      void loadServerSettings();
    }
  });

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    settings[key] = value;
    window.murmurMain.updateSetting(key, value);
  }

  async function updateLaunchOnBoot(enabled: boolean) {
    const previous = settings.launchOnBoot;
    settings.launchOnBoot = enabled;
    try {
      await window.murmurMain.updateSetting('launchOnBoot', enabled);
    } catch {
      settings.launchOnBoot = previous;
      toast('Eve could not update launch on boot', 'error');
    }
  }

  function updateHotwordsCsl(value: string) {
    settings.hotwordsCsl = value;
    window.murmurMain.updateSetting('hotwordsCsl', value);
    hotwordsFileMessage = '';
  }

  function runWithViewTransition(update: () => void): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      update();
      return;
    }

    const docWithTransitions = document as Document & {
      startViewTransition?: (callback: () => void) => { finished: Promise<void> };
    };

    if (!docWithTransitions.startViewTransition) {
      update();
      return;
    }

    docWithTransitions.startViewTransition(() => {
      update();
    });
  }

  function updateUseExternalServer(enabled: boolean) {
    runWithViewTransition(() => {
      updateSetting('useExternalServer', enabled);
    });
    if (enabled) {
      updateExternalServerUrl();
      setTimeout(() => {
        const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        externalServerCard?.scrollIntoView({ behavior, block: 'center' });
      }, 50);
    }
  }

  function openHotkeyCapture(target: 'quick' | 'long') {
    hotkeyCaptureTarget = target;
    isHotkeyModalOpen = true;
  }

  function handleHotkeyCapture(hotkey: Hotkey, displayName: string) {
    isHotkeyModalOpen = false;
    if (hotkeyCaptureTarget === 'long') {
      settings.longHotkey = hotkey;
      longHotkeyDisplayName = displayName;
      window.murmurMain.updateSetting('longHotkey', hotkey);
    } else {
      settings.hotkey = hotkey;
      hotkeyDisplayName = displayName;
      window.murmurMain.updateSetting('hotkey', hotkey);
    }
  }

  function handleHotkeyCancel() {
    isHotkeyModalOpen = false;
  }

  async function resetHotkey() {
    settings.hotkey = { ...DEFAULT_HOTKEY };
    hotkeyDisplayName = await window.murmurMain.getHotkeyDisplayName(DEFAULT_HOTKEY);
    window.murmurMain.updateSetting('hotkey', DEFAULT_HOTKEY);
  }

  async function resetLongHotkey() {
    settings.longHotkey = { ...DEFAULT_LONG_HOTKEY };
    longHotkeyDisplayName = await window.murmurMain.getHotkeyDisplayName(DEFAULT_LONG_HOTKEY);
    window.murmurMain.updateSetting('longHotkey', DEFAULT_LONG_HOTKEY);
  }

  async function importHotwords() {
    const imported = await window.murmurMain.importHotwordsFromFile();
    if (imported === null) {
      return;
    }

    const normalized = formatHotwordsCsl(parseHotwordsCsl(imported));
    updateHotwordsCsl(normalized);
    hotwordsFileMessage = `Imported ${parseHotwordsCsl(normalized).length} terms`;
  }

  async function exportHotwords() {
    const ok = await window.murmurMain.exportHotwordsToFile(settings.hotwordsCsl);
    hotwordsFileMessage = ok ? 'Exported hotwords list' : 'Export canceled';
  }

  function copyVersionToClipboard() {
    const versionLabel = `v${appVersion}`;
    window.murmurMain.copyToClipboard(versionLabel);
    toast(`Copied ${versionLabel}`);
  }

  function updateEngineSetting(key: string, value: unknown) {
    pendingEngine = { ...pendingEngine, [key]: value };
  }

  function selectPreset(preset: typeof SPEECH_MODEL_PRESETS[number]): void {
    if (externalMode || !isEngineAvailable(preset.engine)) return;
    pendingEngine = { ...pendingEngine, ...presetPatch(preset) };
    engineApplyError = '';
  }

  function revertPreset(): void {
    if (!stagedPreset) return;
    const { engine: _engine, [stagedPreset.setting]: _model, ...advancedPending } = pendingEngine;
    pendingEngine = advancedPending;
    engineApplyError = '';
  }

  async function applyEngineSettings() {
    if (engineApplying || Object.keys(pendingEngine).length === 0) return;
    engineApplying = true;
    engineApplyError = '';

    try {
      // Svelte $state objects are Proxies; IPC requires plain cloneable values.
      const patch = Object.fromEntries(Object.entries(pendingEngine));
      const response = await window.murmurMain.updateServerSettings(patch);
      serverSettings = response.settings;
      engineStatus = response.engine_status;
      availableEngines = response.available_engines ?? availableEngines;
      if (!response.reload_started && response.engine_status.status === 'ready' && !response.engine_status.pending) pendingEngine = {};
    } catch (error) {
      // Keep pending changes on failure so user can retry
      engineApplyError = error instanceof Error ? error.message : 'Failed to apply engine settings.';
    } finally {
      engineApplying = false;
    }
  }

  $effect(() => {
    if (Object.keys(pendingEngine).length === 0) return;
    if (preparationFailed) {
      engineApplyError = sharedEngineStatus?.pending?.message ?? sharedEngineStatus?.message ?? 'Engine reload failed.';
      return;
    }
    if (stagedPreset && presetMatchesReadyEngine(stagedPreset, sharedEngineStatus)) {
      pendingEngine = {};
      engineApplyError = '';
    }
  });
</script>

<div class="mx-auto flex h-full min-h-0 min-w-0 w-full max-w-[640px] flex-col px-4 py-4 sm:px-6">
  <div data-scroll-owner="settings-page" class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pr-2">
    {#if settingsLoaded}
    <div class="space-y-7 pb-6">

    <h1 class="sr-only">Settings</h1>

    <!-- Shortcuts & activation -->
    <SettingsSection title="Shortcuts &amp; activation">
      <SettingsRow label="Fast dictation hotkey" description="Start or stop fast dictation">
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={() => openHotkeyCapture('quick')}
            class="max-w-full rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-mono text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
          >
            {hotkeyDisplayName}
          </button>
          {#if isHotkeyChanged}
            <button
              type="button"
              onclick={resetHotkey}
              class="rounded-md p-1.5 text-zinc-500 transition-colors hover:text-zinc-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
              aria-label="Reset fast dictation hotkey to Ctrl+Win"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
              </svg>
            </button>
          {/if}
        </div>
      </SettingsRow>

      <SettingsRow label="Long dictation hotkey" description="Start or stop hands-free long dictation">
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={() => openHotkeyCapture('long')}
            class="max-w-full rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-mono text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
          >
            {longHotkeyDisplayName}
          </button>
          {#if isLongHotkeyChanged}
            <button
              type="button"
              onclick={resetLongHotkey}
              class="rounded-md p-1.5 text-zinc-500 transition-colors hover:text-zinc-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
              aria-label="Reset long dictation hotkey to Ctrl+Shift+Win"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
              </svg>
            </button>
          {/if}
        </div>
      </SettingsRow>

      <SettingsRow label="Activation Mode" description="Hold-to-talk or toggle on/off">
        <div class="relative grid w-full max-w-full grid-cols-2 rounded-lg bg-zinc-800 p-1 sm:w-[120px]">
          <!-- Sliding indicator -->
          <div
            class="absolute top-1 left-1 w-[calc(50%-4px)] h-[calc(100%-8px)] bg-zinc-700 rounded-md transition-all duration-150 ease-out
              {!settings.holdToTalk ? 'translate-x-full' : ''}"
          ></div>
          <!-- Buttons -->
          <button
            type="button"
            onclick={() => updateSetting('holdToTalk', true)}
            aria-pressed={settings.holdToTalk}
            class="relative z-10 rounded-md py-1 text-center text-xs transition-colors duration-150
              cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100
              {settings.holdToTalk ? 'text-zinc-200' : 'text-zinc-400 hover:text-zinc-300'}"
          >
            Hold
          </button>
          <button
            type="button"
            onclick={() => updateSetting('holdToTalk', false)}
            aria-pressed={!settings.holdToTalk}
            class="relative z-10 rounded-md py-1 text-center text-xs transition-colors duration-150
              cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100
              {!settings.holdToTalk ? 'text-zinc-200' : 'text-zinc-400 hover:text-zinc-300'}"
          >
            Toggle
          </button>
        </div>
      </SettingsRow>
    </SettingsSection>

    <!-- Audio -->
    <SettingsSection title="Audio">
      <SettingsRow
        label="Input Device"
        description={audioDeviceError || 'Select microphone for recording'}
      >
        <select
          aria-label="Input Device"
          value={settings.selectedDeviceId}
          onchange={(e) => updateSetting('selectedDeviceId', e.currentTarget.value)}
          disabled={isLoadingDevices}
          title={inputDevices.find(d => d.id === settings.selectedDeviceId)?.label ?? 'Default'}
          class="w-full max-w-full truncate rounded-lg bg-zinc-800 py-1.5 pl-3 pr-8 text-xs text-zinc-300 hover:bg-zinc-700 border border-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed sm:w-auto sm:max-w-[280px]"
        >
          {#each inputDevices as device}
            <option value={device.id}>{device.label}</option>
          {/each}
        </select>
      </SettingsRow>

    </SettingsSection>

    <!-- Dictation/output -->
    <SettingsSection title="Dictation/output">
      <SettingsRow label="Append period" description="Add a period at the end of transcriptions">
        <Toggle
          enabled={settings.appendPeriod}
          onchange={(v) => updateSetting('appendPeriod', v)}
          label="Append period"
        />
      </SettingsRow>

      <SettingsRow label="Append space" description="Add a trailing space after transcriptions">
        <Toggle
          enabled={settings.appendSpace}
          onchange={(v) => updateSetting('appendSpace', v)}
          label="Append space"
        />
      </SettingsRow>

      <SettingsRow label="Dictation mode" description="Local rule-based cleanup before copy or paste">
        <select
          aria-label="Dictation mode"
          value={settings.dictationMode}
          onchange={(e) => updateSetting('dictationMode', e.currentTarget.value as Settings['dictationMode'])}
          class="w-full max-w-full cursor-pointer rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 sm:w-auto"
        >
          <option value="raw">Raw Dictation</option>
          <option value="clean_prompt">Clean Prompt</option>
          <option value="codex_prompt">Codex Prompt</option>
          <option value="message_rewrite">Message Rewrite</option>
          <option value="command">Command Mode</option>
        </select>
      </SettingsRow>
    </SettingsSection>

    <SettingsSection title="Hotwords" variant="panel">
      {#if !hotwordsSupported}
        <div role="status" class="mb-4 flex items-start gap-3 rounded-lg bg-zinc-900/70 p-3">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-400 shrink-0 mt-0.5">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 16v-4"/>
            <path d="M12 8h.01"/>
          </svg>
          <div>
            <p class="text-sm text-zinc-300">Hotwords are not supported with the Nemotron engine.</p>
            <p class="text-xs text-zinc-500 mt-1">Switch to Faster-Whisper to use hotwords.</p>
          </div>
        </div>
      {/if}

      <SettingsRow label="Enable hotwords" description="Bias transcription toward your custom terms">
        <Toggle
          enabled={settings.hotwordsEnabled && hotwordsSupported}
          onchange={(v) => updateSetting('hotwordsEnabled', v)}
          label="Enable hotwords"
          disabled={!hotwordsSupported}
        />
      </SettingsRow>

      <div class="mt-4 w-full min-w-0 border transition-colors
        {!hotwordsSupported ? 'border-zinc-700 bg-zinc-900/50 opacity-50' : hasHotwordOverflowWarning ? 'border-amber-500/70 bg-amber-950/10' : 'border-zinc-700 bg-zinc-900/50'}">
        <label for="hotwords-csl" class="block text-sm text-zinc-200">Custom hotwords (comma-separated)</label>
        <p id="hotwords-help" class="mt-1 text-xs text-zinc-500">
          Add terms that are often transcribed incorrectly, such as product names, acronyms, and proper nouns.
          Avoid very long lists; large lists can reduce quality.
        </p>
        <textarea
          id="hotwords-csl"
          value={settings.hotwordsCsl}
          oninput={(e) => updateHotwordsCsl(e.currentTarget.value)}
          rows="4"
          disabled={!hotwordsSupported}
          aria-describedby="hotwords-help"
          class="mt-3 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed"
          placeholder="Svelte, IPC, Claude"
        ></textarea>

        <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p id="hotwords-count" class="text-xs {hasHotwordOverflowWarning ? 'text-amber-300' : 'text-zinc-500'}">
            {hotwordCount} {hotwordCount === 1 ? 'term' : 'terms'}
            {#if hasHotwordOverflowWarning}
              - You have a lot of entries. Recognition quality may degrade.
            {/if}
          </p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              onclick={importHotwords}
              disabled={!hotwordsSupported}
              class="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100
                {hotwordsSupported ? 'hover:bg-zinc-700 cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
            >
              Import
            </button>
            <button
              type="button"
              onclick={exportHotwords}
              disabled={!hotwordsSupported}
              class="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100
                {hotwordsSupported ? 'hover:bg-zinc-700 cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
            >
              Export
            </button>
          </div>
        </div>

        {#if hotwordsFileMessage}
          <p class="mt-2 text-xs text-zinc-500" role="status">{hotwordsFileMessage}</p>
        {/if}
      </div>
    </SettingsSection>

    <SettingsSection title="Speech model" variant="content">
      {#if !serverConnected || !serverSettings}
        <p class="text-xs text-zinc-500">Speech model choices are available when the server reports its settings.</p>
      {:else}
        <SpeechModelChooser
          selected={selectedPreset}
          availableEngines={availableEngines}
          availabilityKnown={availableEngines.length > 0}
          engineStatus={sharedEngineStatus}
          modelDownload={sharedServerState?.modelDownload}
          externalMode={externalMode}
          onSelect={selectPreset}
        />
        {#if stagedPreset && !presetMatchesReadyEngine(stagedPreset, sharedEngineStatus)}
          <p class="mt-3 text-xs {preparationFailed ? 'text-red-300' : 'text-amber-300'}">{preparationFailed ? 'Preparation failed. Retry or revert your selected model.' : 'Selected model is pending preparation; the current engine remains active until the selected model is ready.'}</p>
        {/if}
        {#if stagedPreset && !externalMode}
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onclick={applyEngineSettings} disabled={engineApplying} class="rounded-lg px-3 py-2 text-xs font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-zinc-100 {engineApplying ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-500 cursor-pointer'}">{engineApplying ? 'Preparing…' : preparationFailed ? 'Retry preparation' : 'Apply and prepare model'}</button>
            <button type="button" onclick={revertPreset} disabled={engineApplying} class="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-zinc-100 {engineApplying ? 'cursor-not-allowed' : 'hover:bg-zinc-800 cursor-pointer'}">Revert</button>
          </div>
          {#if engineApplyError}<p class="mt-2 text-xs text-red-300">{engineApplyError}</p>{/if}
        {/if}
      {/if}
    </SettingsSection>

    <!-- App behavior -->
    <SettingsSection title="App behavior">
      <SettingsRow label="Auto-copy" description="Copy transcription to clipboard automatically">
        <Toggle
          enabled={settings.autoCopy}
          onchange={(v) => updateSetting('autoCopy', v)}
          label="Auto-copy"
        />
      </SettingsRow>

      <SettingsRow label="Auto-paste" description="Paste transcription into active window">
        <Toggle
          enabled={settings.autoPaste}
          onchange={(v) => updateSetting('autoPaste', v)}
          label="Auto-paste"
        />
      </SettingsRow>

      <SettingsRow label="Restore clipboard" description="Put your previous clipboard text back after auto-paste">
        <Toggle
          enabled={settings.restoreClipboardAfterPaste}
          onchange={(v) => updateSetting('restoreClipboardAfterPaste', v)}
          label="Restore clipboard"
        />
      </SettingsRow>

      <SettingsRow label="Paste method" description="Use native SendInput first, or force VBScript fallback">
        <select
          aria-label="Paste method"
          value={settings.pasteMethod}
          onchange={(e) => updateSetting('pasteMethod', e.currentTarget.value as Settings['pasteMethod'])}
          class="w-full max-w-full cursor-pointer rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 sm:w-auto"
        >
          <option value="sendinput">SendInput</option>
          <option value="vbscript">VBScript</option>
        </select>
      </SettingsRow>

      <SettingsRow label="Launch on boot" description="Start application when system starts">
        <Toggle
          enabled={settings.launchOnBoot}
          onchange={(v) => void updateLaunchOnBoot(v)}
          label="Launch on boot"
        />
      </SettingsRow>

      <SettingsRow label="Start minimized" description="Hide main window on application launch">
        <Toggle
          enabled={settings.startMinimized}
          onchange={(v) => updateSetting('startMinimized', v)}
          label="Start minimized"
        />
      </SettingsRow>
    </SettingsSection>

    <section aria-labelledby="advanced-settings-heading" class="min-w-0 space-y-4">
      <div>
        <h2 id="advanced-settings-heading" class="text-base font-semibold text-zinc-100">Advanced</h2>
        <p class="mt-1 text-xs text-zinc-400">
          Engine, connection, diagnostics, and local server controls.
        </p>
      </div>
      <div class="min-w-0 space-y-6">

    <SettingsSection title="Model compatibility">
      {#if !serverConnected}
        <div class="p-4 bg-zinc-900/50 rounded-xl w-full">
          <p class="text-xs text-zinc-500 text-center">
            Server not connected. Start the server to configure engine settings.
          </p>
        </div>
      {:else if serverSettings}
        {#if serverSettings.whisper_model}
          <SettingsRow label={serverSettings.whisper_model.label} description="Raw Whisper compatibility model, including Medium and Tiny">
            <select
              aria-label={serverSettings.whisper_model.label}
              value={getSettingValue('whisper_model') ?? serverSettings.whisper_model.value}
              onchange={(e) => updateEngineSetting('whisper_model', e.currentTarget.value)}
              class="w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 py-1.5 pl-3 pr-8 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 sm:w-auto"
            >
              {#each getOptions('whisper_model') as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </SettingsRow>
        {/if}
        {#if serverSettings.whisper_compute_type}
          <SettingsRow label={serverSettings.whisper_compute_type.label} description={serverSettings.whisper_compute_type.description}>
            <select
              aria-label={serverSettings.whisper_compute_type.label}
              value={getSettingValue('whisper_compute_type') ?? serverSettings.whisper_compute_type.value}
              onchange={(e) => updateEngineSetting('whisper_compute_type', e.currentTarget.value)}
              class="w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 py-1.5 pl-3 pr-8 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 sm:w-auto"
            >
              {#each getOptions('whisper_compute_type') as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </SettingsRow>
        {/if}

        <!-- Advanced (collapsible) -->
        <div class="w-full">
          <button
            type="button"
            aria-expanded={engineAdvancedOpen}
            aria-controls="engine-advanced-options"
            onclick={() => engineAdvancedOpen = !engineAdvancedOpen}
            class="flex items-center gap-2 py-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              class="transition-transform duration-150 {engineAdvancedOpen ? 'rotate-90' : ''}"
            >
              <path d="m9 18 6-6-6-6"/>
            </svg>
            Advanced
          </button>

           {#if engineAdvancedOpen}
             <div id="engine-advanced-options" class="mt-2 space-y-2">
               {#if serverSettings.nemotron_model && isVisible(serverSettings.nemotron_model)}
                 <SettingsRow label={serverSettings.nemotron_model.label} description="Raw Nemotron model name or path">
                   <input aria-label={serverSettings.nemotron_model.label} value={getSettingValue<string>('nemotron_model') ?? String(serverSettings.nemotron_model.value)} oninput={(e) => updateEngineSetting('nemotron_model', e.currentTarget.value)} class="w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 sm:w-56" />
                 </SettingsRow>
               {/if}
               {#if serverSettings.whisper_language && isVisible(serverSettings.whisper_language)}
                 <SettingsRow label={serverSettings.whisper_language.label} description={serverSettings.whisper_language.description}>
                   <input aria-label={serverSettings.whisper_language.label} value={getSettingValue<string>('whisper_language') ?? String(serverSettings.whisper_language.value ?? '')} oninput={(e) => updateEngineSetting('whisper_language', e.currentTarget.value)} class="w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 sm:w-28" />
                 </SettingsRow>
               {/if}
               <!-- Device setting (show whichever is visible) -->
              {#if serverSettings.nemotron_device && isVisible(serverSettings.nemotron_device)}
                <SettingsRow label="Device" description="Hardware device for inference">
                  <select
                    aria-label="Nemotron device"
                    value={getSettingValue('nemotron_device') ?? serverSettings.nemotron_device.value}
                    onchange={(e) => updateEngineSetting('nemotron_device', e.currentTarget.value)}
                    class="w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 py-1.5 pl-3 pr-8 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 sm:w-auto"
                  >
                    {#each getOptions('nemotron_device') as option}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </SettingsRow>
              {/if}

              {#if serverSettings.whisper_device && isVisible(serverSettings.whisper_device)}
                <SettingsRow label="Device" description="Hardware device for inference">
                  <select
                    aria-label="Whisper device"
                    value={getSettingValue('whisper_device') ?? serverSettings.whisper_device.value}
                    onchange={(e) => updateEngineSetting('whisper_device', e.currentTarget.value)}
                    class="w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 py-1.5 pl-3 pr-8 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 sm:w-auto"
                  >
                    {#each getOptions('whisper_device') as option}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </SettingsRow>
              {/if}

              <!-- Unload before swap toggle -->
              {#if serverSettings.unload_before_swap}
                <SettingsRow label="Unload before swap" description="Free VRAM before loading new engine (for low-VRAM GPUs)">
                  <Toggle
                    enabled={!!getSettingValue('unload_before_swap')}
                    onchange={(v) => updateEngineSetting('unload_before_swap', v)}
                    label="Unload before swap"
                  />
                </SettingsRow>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Advanced compatibility changes remain explicit. -->
        {#if Object.keys(pendingEngine).length > 0 && !stagedPreset}
          <div class="w-full rounded-xl border border-zinc-700 bg-zinc-900/50 p-4">
            <div class="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400">
                <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
              <p class="text-xs text-amber-300">Changes require engine reload</p>
            </div>
            <button
              onclick={applyEngineSettings}
              disabled={engineApplying}
              class="px-4 py-2 rounded-lg text-xs font-medium transition-colors
                {engineApplying
                  ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'}"
            >
              {#if engineApplying}
                <span class="flex items-center gap-2">
                  <svg class="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Applying...
                </span>
              {:else}
                Apply advanced changes
              {/if}
            </button>
            {#if engineApplyError}
              <p class="mt-2 text-xs text-red-400">{engineApplyError}</p>
            {/if}
          </div>
        {/if}

        <!-- Engine status -->
        {#if engineStatus}
          <div class="flex items-center justify-between p-4 bg-zinc-900/50 rounded-xl w-full">
            <div class="flex items-center gap-2">
              <span class="text-xs text-zinc-500">Status:</span>
              {#if engineStatus.status === 'ready' && !engineStatus.pending}
                <span class="flex items-center gap-1.5 text-xs text-emerald-400">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                  Ready
                </span>
              {:else if engineStatus.status === 'loading' || engineStatus.pending}
                <span class="flex items-center gap-1.5 text-xs text-amber-400">
                  <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
                  Loading{engineStatus.pending?.message ? `: ${engineStatus.pending.message}` : '...'}
                </span>
              {:else if engineStatus.status === 'error'}
                <span class="flex items-center gap-1.5 text-xs text-red-400">
                  <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                  Error{engineStatus.message ? `: ${engineStatus.message}` : ''}
                </span>
              {/if}
            </div>
            {#if engineStatus.info}
              <div class="flex flex-col items-end gap-0.5">
                <span class="text-xs text-zinc-500">~{engineStatus.info.model_size_gb} GB model</span>
                {#if engineStatus.info.gpu_vram_gb != null}
                  <span class="max-w-[260px] truncate text-xs text-zinc-500" title={engineStatus.info.gpu_name ?? 'GPU'}>
                    {engineStatus.info.gpu_name ?? 'GPU'} • {engineStatus.info.gpu_vram_gb.toFixed(1)} GB VRAM
                  </span>
                {/if}
                {#if engineStatus.info.estimated_max_duration_s != null}
                  <span
                    class="text-xs text-zinc-400 cursor-help border-b border-dotted border-zinc-600"
                    title={estimatedDurationTooltip(engineStatus.info)}
                  >
                    Est. max per recording: {formatEstimatedDuration(engineStatus.info.estimated_max_duration_s)}
                  </span>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      {/if}
    </SettingsSection>

    <SettingsSection title="Server">
      <SettingsRow
        label="Use external server"
        description="Connect to your own server and disable built-in server management"
      >
        <Toggle
          enabled={settings.useExternalServer}
          onchange={updateUseExternalServer}
          label="Use external server"
        />
      </SettingsRow>

      <div class="overflow-hidden [view-transition-name:external-server-panel]">
        {#if settings.useExternalServer}
          <div bind:this={externalServerCard} class="mt-2 p-4 bg-zinc-900/50 rounded-xl border border-zinc-800 w-full">
            <p class="text-sm text-zinc-200 mb-1">Custom server endpoint</p>
            <p class="text-xs text-zinc-500 mb-3">
              Set the host and port for your transcription server. Eve connects to <span class="font-mono">/transcribe</span>.
            </p>

            {#if externalServerError}
              <p class="mb-3 text-xs text-red-300">{externalServerError}</p>
            {:else}
              <p class="mb-3 text-xs text-zinc-500">
                Using endpoint <span class="font-mono text-zinc-300">{settings.serverUrl}</span>
              </p>
            {/if}

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label for="external-server-host" class="text-xs text-zinc-500 block mb-1">Host</label>
                <input
                  id="external-server-host"
                  type="text"
                  value={externalServerHost}
                  onpaste={(e) => {
                    const pasted = e.clipboardData?.getData('text') ?? '';
                    if (!pasted) {
                      return;
                    }
                    const parsed = parseHostPaste(pasted);
                    if (parsed.host) {
                      e.preventDefault();
                      externalServerHost = parsed.host;
                      if (parsed.port) {
                        externalServerPort = parsed.port;
                      }
                      updateExternalServerUrl();
                    }
                  }}
                  oninput={(e) => {
                    externalServerHost = e.currentTarget.value;
                    updateExternalServerUrl();
                  }}
                  class="w-full bg-zinc-800 border border-zinc-700 rounded-lg
                    px-3 py-2 text-sm text-zinc-300 font-mono
                    focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
                  placeholder="localhost"
                />
              </div>

              <div>
                <label for="external-server-port" class="text-xs text-zinc-500 block mb-1">Port</label>
                <input
                  id="external-server-port"
                  type="text"
                  value={externalServerPort}
                  oninput={(e) => {
                    externalServerPort = e.currentTarget.value;
                    updateExternalServerUrl();
                  }}
                  class="w-full bg-zinc-800 border border-zinc-700 rounded-lg
                    px-3 py-2 text-sm text-zinc-300 font-mono
                    focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
                  placeholder="51717"
                />
              </div>
            </div>
          </div>
        {/if}
      </div>
    </SettingsSection>

    <ServerView embedded />

      </div>
    </section>

    <SettingsSection title="About">
      <SettingsRow label="Version" description="Installed Eve build version">
        <button
          type="button"
          onclick={copyVersionToClipboard}
          title="Click to copy version"
          class="rounded-lg bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
        >
          v{appVersion}
        </button>
      </SettingsRow>
    </SettingsSection>

    </div>
    {:else}
      <SettingsSkeleton />
    {/if}
  </div>
</div>

<HotkeyCaptureModal
  isOpen={isHotkeyModalOpen}
  onCapture={handleHotkeyCapture}
  onCancel={handleHotkeyCancel}
/>
