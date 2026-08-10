<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsGroup from '../components/SettingsGroup.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import PrimaryPage from '../components/PrimaryPage.svelte';
  import EveDropdown, { type EveDropdownOption } from '../components/EveDropdown.svelte';
  import HotkeyCaptureModal from '../components/HotkeyCaptureModal.svelte';
  import SettingsSkeleton from '../components/SettingsSkeleton.svelte';
  import ServerView from './ServerView.svelte';
  import SpeechModelChooser from '../components/SpeechModelChooser.svelte';
  import { SPEECH_MODEL_PRESETS, hasPendingCompatibilityChanges, presetMatchesReadyEngine, presetPatch, stagedPresetFromPending } from '../speech-model-presets';
  import { getServerManagementMode, serverStatusState } from '../server-status';
  import {
    recoverInterruptedManagedPreparation,
    serverSettingsStateKey,
    shouldClearServerSettings,
    shouldRetryServerSettings,
  } from '../server-settings-recovery';
  import { disabledOptionReasons, optionsForDraftWhisperDevice } from '../server-setting-options';
  import { enginePreparationPhase, shouldDisableEngineRevert, shouldRefreshCommittedSettings } from '../engine-settings-transaction';
  import { toast } from '$lib/toast.svelte';
  import { DEFAULT_SETTINGS, type Settings, type Hotkey, type EngineStatus, type ServerSetting, type ServerSettingOption } from '$shared/types';
  import { HOTWORDS_WARNING_THRESHOLD, formatHotwordsCsl, parseHotwordsCsl } from '$shared/hotwords';

  const DEFAULT_SERVER_HOST = 'localhost';
  const DEFAULT_SERVER_PORT = 51717;
  const TRANSCRIBE_PATH = '/transcribe';

  const DICTATION_MODE_OPTIONS: EveDropdownOption[] = [
    { value: 'raw', label: 'Raw Dictation' },
    { value: 'clean_prompt', label: 'Clean Prompt' },
    { value: 'codex_prompt', label: 'Codex Prompt' },
    { value: 'message_rewrite', label: 'Message Rewrite' },
    { value: 'command', label: 'Command Mode' },
  ];
  const PASTE_METHOD_OPTIONS: EveDropdownOption[] = [
    { value: 'sendinput', label: 'SendInput' },
    { value: 'vbscript', label: 'VBScript' },
  ];

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

  let hotwordEntries = $derived(parseHotwordsCsl(settings.hotwordsCsl));
  let hotwordCount = $derived(hotwordEntries.length);
  let hasHotwordOverflowWarning = $derived(hotwordCount > HOTWORDS_WARNING_THRESHOLD);

  // Server/engine settings state
  let serverSettings = $state<Record<string, ServerSetting<unknown>> | null>(null);
  let engineStatus = $state<EngineStatus | null>(null);
  let serverConnected = $state(false);
  let serverSettingsLoading = $state(false);
  let lastServerSettingsAttemptKey = $state<string | null>(null);
  let compatibilityControlsOpen = $state(false);
  let engineApplying = $state(false);
  let enginePreparationRequested = $state(false);
  let enginePreparationActive = $state(false);
  let enginePreparationObserved = $state(false);
  let refreshingCommittedSettings = $state(false);
  let availableEngines = $state<string[]>([]);
  let engineApplyError = $state('');

  // Local engine settings (track pending changes before apply)
  let pendingEngine = $state<Record<string, unknown>>({});
  let sharedServerState = $derived($serverStatusState.state);
  let sharedEngineStatus = $derived(engineStatus ?? sharedServerState?.engineStatus ?? null);
  let externalMode = $derived(settings.useExternalServer || getServerManagementMode($serverStatusState) === 'external');

  // Derive current values (server value overridden by pending)
  function getSettingValue<T>(key: string): T | undefined {
    if (key in pendingEngine) return pendingEngine[key] as T;
    const setting = serverSettings?.[key];
    return setting?.value as T | undefined;
  }

  let selectedEngine = $derived(getSettingValue<string>('engine') ?? 'nemotron');
  let draftWhisperDevice = $derived(getSettingValue<string>('whisper_device') ?? 'auto');
  let selectedPreset = $derived(SPEECH_MODEL_PRESETS.find((preset) =>
    getSettingValue<string>('engine') === preset.engine && getSettingValue<string>(preset.setting) === preset.model
  ) ?? null);
  let stagedPreset = $derived(stagedPresetFromPending(pendingEngine));
  let preparationFailed = $derived(
    enginePreparationPhase(sharedEngineStatus) === 'failed' ||
    (!enginePreparationActive && stagedPreset !== null && sharedServerState?.modelDownload?.model === stagedPreset.model && sharedServerState.modelDownload.status === 'error')
  );
  let engineRevertDisabled = $derived(shouldDisableEngineRevert(enginePreparationActive));

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
  function getOptions(key: string): Array<ServerSettingOption<unknown>> {
    return (serverSettings?.[key]?.options as Array<ServerSettingOption<unknown>>) ?? [];
  }

  function getWhisperComputeOptions(): Array<ServerSettingOption<unknown>> {
    return optionsForDraftWhisperDevice(
      getOptions('whisper_compute_type'),
      draftWhisperDevice,
    );
  }

  function toDropdownOptions(options: Array<ServerSettingOption<unknown>>): EveDropdownOption[] {
    return options.map((option) => ({
      value: String(option.value),
      label: option.label,
      disabled: option.disabled,
      description: option.reason,
    }));
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

  async function loadServerSettings(): Promise<boolean> {
    if (serverSettingsLoading) return false;
    serverSettingsLoading = true;
    try {
      const serverData = await window.murmurMain.getServerSettings();
      serverSettings = serverData.settings;
      engineStatus = serverData.engine_status;
      availableEngines = serverData.available_engines ?? [];
      serverConnected = true;
      return true;
    } catch {
      serverSettings = null;
      engineStatus = null;
      availableEngines = [];
      serverConnected = false;
      return false;
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
      const recovery = recoverInterruptedManagedPreparation(state, externalMode, {
        pending: pendingEngine,
        requested: enginePreparationRequested,
        active: enginePreparationActive,
        observed: enginePreparationObserved,
        applying: engineApplying,
      });
      serverSettings = null;
      engineStatus = null;
      availableEngines = [];
      serverConnected = false;
      lastServerSettingsAttemptKey = null;
      if (recovery) {
        pendingEngine = recovery.pending;
        enginePreparationRequested = recovery.requested;
        enginePreparationActive = recovery.active;
        enginePreparationObserved = recovery.observed;
        engineApplying = recovery.applying;
        if (recovery.message) engineApplyError = recovery.message;
      }
      return;
    }

    if (state?.engineStatus) {
      engineStatus = state.engineStatus;
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

  function updateUseExternalServer(enabled: boolean) {
    updateSetting('useExternalServer', enabled);
    if (enabled) {
      updateExternalServerUrl();
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

  function revertEngineSettings(): void {
    if (enginePreparationActive) return;
    pendingEngine = {};
    enginePreparationRequested = false;
    enginePreparationActive = false;
    enginePreparationObserved = false;
    engineApplyError = '';
    void loadServerSettings();
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
      if (response.reload_started) {
        enginePreparationRequested = true;
        enginePreparationActive = true;
        enginePreparationObserved = response.engine_status.status === 'loading' || !!response.engine_status.pending;
        if (!enginePreparationObserved) {
          await confirmEnginePreparationStatus();
        }
      } else if (response.engine_status.status === 'ready' && !response.engine_status.pending) {
        pendingEngine = {};
      }
    } catch (error) {
      // Keep pending changes on failure so user can retry
      engineApplyError = error instanceof Error ? error.message : 'Failed to apply engine settings.';
    } finally {
      engineApplying = false;
    }
  }

  async function confirmEnginePreparationStatus(): Promise<void> {
    if (!(await loadServerSettings())) return;

    const phase = enginePreparationPhase(engineStatus);
    if (phase === 'preparing') {
      enginePreparationObserved = true;
      return;
    }
    if (phase === 'failed') {
      enginePreparationActive = false;
      engineApplyError = engineStatus?.pending?.message ?? engineStatus?.message ?? 'Engine reload failed.';
      return;
    }
    if (phase === 'ready') {
      const candidateCommitted = Object.entries(pendingEngine).every(
        ([key, value]) => serverSettings?.[key]?.value === value,
      );
      if (!candidateCommitted) return;
      pendingEngine = {};
      enginePreparationRequested = false;
      enginePreparationActive = false;
      enginePreparationObserved = false;
      engineApplyError = '';
    }
  }

  $effect(() => {
    if (enginePreparationActive && (sharedEngineStatus?.status === 'loading' || !!sharedEngineStatus?.pending)) {
      enginePreparationObserved = true;
    }
    if (Object.keys(pendingEngine).length === 0) return;
    if (preparationFailed) {
      if (enginePreparationActive && !enginePreparationObserved) return;
      enginePreparationActive = false;
      engineApplyError = sharedEngineStatus?.pending?.message ?? sharedEngineStatus?.message ?? 'Engine reload failed.';
      return;
    }
    if (shouldRefreshCommittedSettings(
      pendingEngine,
      enginePreparationRequested,
      enginePreparationObserved,
      preparationFailed,
      sharedEngineStatus,
    )) {
      void refreshCommittedSettings();
    }
  });

  async function refreshCommittedSettings(): Promise<void> {
    if (refreshingCommittedSettings) return;
    refreshingCommittedSettings = true;
    try {
      if (await loadServerSettings()) {
        pendingEngine = {};
        enginePreparationRequested = false;
        enginePreparationActive = false;
        enginePreparationObserved = false;
        engineApplyError = '';
      }
    } finally {
      refreshingCommittedSettings = false;
    }
  }
</script>

<PrimaryPage page="settings" scrollOwner="settings-page" contentClass="pb-6">
  <div class="mx-auto min-h-full min-w-0 w-full max-w-[640px] space-y-7">
    {#if settingsLoaded}
    <div class="space-y-7 pb-6">

    <h1 class="sr-only">Settings</h1>

    <SettingsSection title="General" description="Shortcuts, audio, dictation, vocabulary, and app behavior." variant="content">
      <div data-settings-general class="space-y-6">
        <SettingsGroup title="Shortcuts &amp; activation">
          <SettingsRow label="Fast dictation hotkey" description="Start or stop fast dictation">
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={() => openHotkeyCapture('quick')}
                class="min-h-9 max-w-full rounded-lg bg-zinc-800 px-3 py-2 text-xs font-mono text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
              >
                {hotkeyDisplayName}
              </button>
              {#if isHotkeyChanged}
                <button
                  type="button"
                  onclick={resetHotkey}
                  class="min-h-8 rounded-md p-1.5 text-zinc-500 transition-colors hover:text-zinc-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
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
                class="min-h-9 max-w-full rounded-lg bg-zinc-800 px-3 py-2 text-xs font-mono text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
              >
                {longHotkeyDisplayName}
              </button>
              {#if isLongHotkeyChanged}
                <button
                  type="button"
                  onclick={resetLongHotkey}
                  class="min-h-8 rounded-md p-1.5 text-zinc-500 transition-colors hover:text-zinc-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
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

          <SettingsRow label="Activation mode" description="Hold-to-talk or toggle on/off">
            <div class="relative grid min-h-9 w-full max-w-full grid-cols-2 rounded-lg bg-zinc-800 p-1 sm:w-[120px]">
              <div
                class="absolute top-1 left-1 h-[calc(100%-8px)] w-[calc(50%-4px)] rounded-md bg-zinc-700 transition-all duration-150 ease-out
                  {!settings.holdToTalk ? 'translate-x-full' : ''}"
              ></div>
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
        </SettingsGroup>

        <SettingsGroup title="Audio">
          <SettingsRow
            label="Input device"
            description={audioDeviceError || 'Select microphone for recording'}
          >
            <EveDropdown
              label="Input device"
              value={settings.selectedDeviceId}
              options={inputDevices.map((device) => ({ value: device.id, label: device.label }))}
              onchange={(value) => updateSetting('selectedDeviceId', value)}
              disabled={isLoadingDevices}
              class="sm:max-w-[280px]"
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Dictation/output">
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
            <EveDropdown
              label="Dictation mode"
              value={settings.dictationMode}
              options={DICTATION_MODE_OPTIONS}
              onchange={(value) => updateSetting('dictationMode', value as Settings['dictationMode'])}
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Hotwords" description="Keep important names and terms recognizable.">
          {#if !hotwordsSupported}
            <div role="status" class="flex items-start gap-3 p-4 text-sm">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mt-0.5 shrink-0 text-zinc-400">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4"/>
                <path d="M12 8h.01"/>
              </svg>
              <div>
                <p class="text-zinc-300">Hotwords are not supported with the Nemotron engine.</p>
                <p class="mt-1 text-xs text-zinc-500">Switch to Faster-Whisper to use hotwords.</p>
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

          <div data-hotwords-editor class="p-4 transition-colors {!hotwordsSupported ? 'bg-zinc-900/40 opacity-60' : hasHotwordOverflowWarning ? 'bg-amber-950/10' : ''}">
            <label for="hotwords-csl" class="block text-sm text-zinc-200">Custom hotwords (comma-separated)</label>
            <p id="hotwords-help" class="mt-1 text-xs leading-5 text-zinc-500">
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
              class="mt-3 min-h-24 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Svelte, IPC, Claude"
            ></textarea>

            <div class="mt-3 flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p id="hotwords-count" class="min-w-0 text-xs {hasHotwordOverflowWarning ? 'text-amber-300' : 'text-zinc-500'}">
                {hotwordCount} {hotwordCount === 1 ? 'term' : 'terms'}
                {#if hasHotwordOverflowWarning}
                  - You have a lot of entries. Recognition quality may degrade.
                {/if}
              </p>
              <div class="flex min-w-0 flex-wrap gap-2">
                <button
                  type="button"
                  onclick={importHotwords}
                  disabled={!hotwordsSupported}
                  class="min-h-9 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100
                    {hotwordsSupported ? 'cursor-pointer hover:bg-zinc-700' : 'cursor-not-allowed opacity-50'}"
                >
                  Import
                </button>
                <button
                  type="button"
                  onclick={exportHotwords}
                  disabled={!hotwordsSupported}
                  class="min-h-9 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100
                    {hotwordsSupported ? 'cursor-pointer hover:bg-zinc-700' : 'cursor-not-allowed opacity-50'}"
                >
                  Export
                </button>
              </div>
            </div>

            {#if hotwordsFileMessage}
              <p class="mt-2 text-xs text-zinc-500" role="status">{hotwordsFileMessage}</p>
            {/if}
          </div>
        </SettingsGroup>

        <SettingsGroup title="App behavior">
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
            <EveDropdown
              label="Paste method"
              value={settings.pasteMethod}
              options={PASTE_METHOD_OPTIONS}
              onchange={(value) => updateSetting('pasteMethod', value as Settings['pasteMethod'])}
            />
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
        </SettingsGroup>
      </div>
    </SettingsSection>

    <SettingsSection title="Speech model" variant="content">
      {#if !serverConnected || !serverSettings}
        <div data-speech-model-panel class="min-w-0 w-full rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:p-5">
          <p class="text-xs leading-5 text-zinc-500">Speech model choices are available when the server reports its settings.</p>
          {#if engineApplyError}
            <p data-engine-preparation-interrupted role="alert" class="mt-2 text-xs leading-5 text-red-300">{engineApplyError}</p>
          {/if}
        </div>
      {:else}
        <SpeechModelChooser
          selected={selectedPreset}
          availableEngines={availableEngines}
          availabilityKnown={availableEngines.length > 0}
          engineStatus={sharedEngineStatus}
          modelDownload={sharedServerState?.modelDownload}
          externalMode={externalMode}
          preparationFailed={preparationFailed}
          onSelect={selectPreset}
        >
          {#snippet children()}
            {#if stagedPreset && !presetMatchesReadyEngine(stagedPreset, sharedEngineStatus)}
              <p data-model-preparation-status class="text-xs leading-5 {preparationFailed ? 'text-red-300' : 'text-amber-300'}">
                {preparationFailed ? 'Preparation failed. Retry or revert your selected model.' : 'Selected model is pending preparation; the current engine remains active until the selected model is ready.'}
              </p>
            {/if}
            {#if stagedPreset && !externalMode}
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" onclick={applyEngineSettings} disabled={engineApplying} class="min-h-9 rounded-lg px-3 py-2 text-xs font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-zinc-100 {engineApplying ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed' : 'bg-zinc-100 text-zinc-950 hover:bg-white cursor-pointer'}">{engineApplying ? 'Preparing…' : preparationFailed ? 'Retry preparation' : 'Apply and prepare model'}</button>
                <button type="button" onclick={revertEngineSettings} disabled={engineApplying || engineRevertDisabled} class="min-h-9 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-zinc-100 {engineApplying || engineRevertDisabled ? 'cursor-not-allowed' : 'hover:bg-zinc-800 cursor-pointer'}">Revert</button>
              </div>
              {#if engineApplyError}<p class="mt-2 text-xs text-red-300">{engineApplyError}</p>{/if}
            {/if}
          {/snippet}
        </SpeechModelChooser>
      {/if}
    </SettingsSection>

    <SettingsSection
      title="Advanced"
      id="advanced-settings-heading"
      description="Raw engine compatibility controls for advanced setups."
      variant="content"
    >
      <div data-advanced-settings class="min-w-0">
        <div data-compatibility-panel class="min-w-0 w-full rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="text-sm font-medium text-zinc-100">Compatibility controls</h3>
              <p class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">Raw model, precision, language, device, and unload-before-swap settings.</p>
            </div>
            {#if serverConnected && serverSettings}
              <button
                type="button"
                aria-expanded={compatibilityControlsOpen}
                aria-controls="compatibility-controls"
                onclick={() => compatibilityControlsOpen = !compatibilityControlsOpen}
                class="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                  class="transition-transform duration-150 {compatibilityControlsOpen ? 'rotate-90' : ''}"
                  aria-hidden="true"
                >
                  <path d="m9 18 6-6-6-6"/>
                </svg>
                {compatibilityControlsOpen ? 'Hide controls' : 'Show controls'}
              </button>
            {/if}
          </div>

          {#if externalMode}
            <div data-compatibility-external class="mt-4 flex items-start gap-3 border-t border-white/[0.08] pt-4 text-xs leading-5 text-zinc-400">
              <span class="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-amber-300"></span>
              <p>Compatibility controls are read-only while an external server is active. Configure the external server through its own endpoint.</p>
            </div>
          {/if}

      {#if !serverConnected}
        <div class="mt-4 border-t border-white/[0.08] pt-4">
          <p class="text-xs leading-5 text-zinc-500">
            Server not connected. Start the server to configure engine settings.
          </p>
        </div>
      {:else if serverSettings}
        <div id="compatibility-controls" hidden={!compatibilityControlsOpen} class="mt-4 divide-y divide-white/[0.08] border-t border-white/[0.08] pt-2 {externalMode ? 'opacity-60' : ''}">
        {#if serverSettings.whisper_model}
          <SettingsRow label={serverSettings.whisper_model.label} description="Raw Whisper compatibility model, including Medium and Tiny">
            <EveDropdown
              label={serverSettings.whisper_model.label}
              value={String(getSettingValue('whisper_model') ?? serverSettings.whisper_model.value)}
              options={toDropdownOptions(getOptions('whisper_model'))}
              onchange={(value) => updateEngineSetting('whisper_model', value)}
              disabled={externalMode}
            />
          </SettingsRow>
        {/if}
        {#if serverSettings.whisper_compute_type}
          <SettingsRow label={serverSettings.whisper_compute_type.label} description={serverSettings.whisper_compute_type.description}>
            <EveDropdown
              label={serverSettings.whisper_compute_type.label}
              value={String(getSettingValue('whisper_compute_type') ?? serverSettings.whisper_compute_type.value)}
              options={toDropdownOptions(getWhisperComputeOptions())}
              onchange={(value) => updateEngineSetting('whisper_compute_type', value)}
              disabled={externalMode}
            />
            {#each disabledOptionReasons(getWhisperComputeOptions()) as reason}
              <p data-setting-option-reason class="mt-1 text-xs leading-5 text-amber-300">{reason}</p>
            {/each}
          </SettingsRow>
        {/if}

        {#if serverSettings.nemotron_model && isVisible(serverSettings.nemotron_model)}
          <SettingsRow label={serverSettings.nemotron_model.label} description="Raw Nemotron model name or path">
            <input
              aria-label={serverSettings.nemotron_model.label}
              value={getSettingValue<string>('nemotron_model') ?? String(serverSettings.nemotron_model.value)}
              oninput={(e) => updateEngineSetting('nemotron_model', e.currentTarget.value)}
              disabled={externalMode}
              class="min-h-9 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 sm:w-56"
            />
          </SettingsRow>
        {/if}
        {#if serverSettings.whisper_language && isVisible(serverSettings.whisper_language)}
          <SettingsRow label={serverSettings.whisper_language.label} description={serverSettings.whisper_language.description}>
            <input
              aria-label={serverSettings.whisper_language.label}
              value={getSettingValue<string>('whisper_language') ?? String(serverSettings.whisper_language.value ?? '')}
              oninput={(e) => updateEngineSetting('whisper_language', e.currentTarget.value)}
              disabled={externalMode}
              class="min-h-9 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 sm:w-28"
            />
          </SettingsRow>
        {/if}
        {#if serverSettings.nemotron_device && isVisible(serverSettings.nemotron_device)}
          <SettingsRow label="Device" description="Hardware device for inference">
            <EveDropdown
              label="Nemotron device"
              value={String(getSettingValue('nemotron_device') ?? serverSettings.nemotron_device.value)}
              options={toDropdownOptions(getOptions('nemotron_device'))}
              onchange={(value) => updateEngineSetting('nemotron_device', value)}
              disabled={externalMode}
            />
            {#each disabledOptionReasons(getOptions('nemotron_device')) as reason}
              <p data-setting-option-reason class="mt-1 text-xs leading-5 text-amber-300">{reason}</p>
            {/each}
          </SettingsRow>
        {/if}
        {#if serverSettings.whisper_device && isVisible(serverSettings.whisper_device)}
          <SettingsRow label="Device" description="Hardware device for inference">
            <EveDropdown
              label="Whisper device"
              value={String(getSettingValue('whisper_device') ?? serverSettings.whisper_device.value)}
              options={toDropdownOptions(getOptions('whisper_device'))}
              onchange={(value) => updateEngineSetting('whisper_device', value)}
              disabled={externalMode}
            />
            {#each disabledOptionReasons(getOptions('whisper_device')) as reason}
              <p data-setting-option-reason class="mt-1 text-xs leading-5 text-amber-300">{reason}</p>
            {/each}
          </SettingsRow>
        {/if}
        {#if serverSettings.unload_before_swap}
          <SettingsRow label="Unload before swap" description="Free VRAM before loading a new engine on low-VRAM GPUs">
            <Toggle
              enabled={!!getSettingValue('unload_before_swap')}
              onchange={(v) => updateEngineSetting('unload_before_swap', v)}
              label="Unload before swap"
              disabled={externalMode}
            />
          </SettingsRow>
        {/if}
        </div>

        {#if hasPendingCompatibilityChanges(pendingEngine, stagedPreset)}
          <div data-compatibility-footer class="mt-4 border-t border-white/[0.08] pt-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <p class="text-xs text-amber-300">Compatibility changes require an engine reload.</p>
              {#if !stagedPreset}
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onclick={applyEngineSettings}
                    disabled={engineApplying || externalMode}
                    class="min-h-9 rounded-lg px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100
                      {engineApplying || externalMode
                        ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed'
                        : 'bg-zinc-100 text-zinc-950 hover:bg-white cursor-pointer'}"
                  >
                    {#if engineApplying}
                      Preparing…
                    {:else if preparationFailed}
                      Retry compatibility changes
                    {:else}
                      Apply compatibility changes
                    {/if}
                  </button>
                  <button type="button" onclick={revertEngineSettings} disabled={engineApplying || engineRevertDisabled || externalMode} class="min-h-9 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-zinc-100 {engineApplying || engineRevertDisabled || externalMode ? 'cursor-not-allowed' : 'hover:bg-zinc-800 cursor-pointer'}">Revert</button>
                </div>
              {/if}
            </div>
            {#if engineApplyError}
              <p class="mt-2 text-xs text-red-300">{engineApplyError}</p>
            {/if}
          </div>
        {/if}

        {#if sharedEngineStatus}
          <div data-engine-status class="mt-4 flex flex-wrap items-start justify-between gap-3 border-t border-white/[0.08] pt-4">
            <div class="flex items-center gap-2">
              <span class="text-xs text-zinc-500">Engine status:</span>
              {#if sharedEngineStatus.status === 'ready' && !sharedEngineStatus.pending}
                <span class="flex items-center gap-1.5 text-xs text-emerald-300">
                  <span class="h-1.5 w-1.5 rounded-full bg-emerald-300"></span>
                  Ready
                </span>
              {:else if sharedEngineStatus.status === 'loading' || sharedEngineStatus.pending}
                <span class="flex items-center gap-1.5 text-xs text-amber-300">
                  <span class="h-1.5 w-1.5 rounded-full bg-amber-300"></span>
                  Preparing{sharedEngineStatus.pending?.message ? `: ${sharedEngineStatus.pending.message}` : '...'}
                </span>
              {:else if sharedEngineStatus.status === 'error'}
                <span class="flex items-center gap-1.5 text-xs text-red-300">
                  <span class="h-1.5 w-1.5 rounded-full bg-red-300"></span>
                  Error{sharedEngineStatus.message ? `: ${sharedEngineStatus.message}` : ''}
                </span>
              {/if}
            </div>
            {#if sharedEngineStatus.info}
              <div class="flex min-w-0 flex-col items-start gap-0.5 sm:items-end">
                <span class="text-xs text-zinc-500">~{sharedEngineStatus.info.model_size_gb} GB model</span>
                {#if sharedEngineStatus.info.gpu_vram_gb != null}
                  <span class="max-w-full truncate text-xs text-zinc-500" title={sharedEngineStatus.info.gpu_name ?? 'GPU'}>
                    {sharedEngineStatus.info.gpu_name ?? 'GPU'} • {sharedEngineStatus.info.gpu_vram_gb.toFixed(1)} GB VRAM
                  </span>
                {/if}
                {#if sharedEngineStatus.info.estimated_max_duration_s != null}
                  <span
                    class="text-xs text-zinc-400 cursor-help border-b border-dotted border-zinc-600"
                    title={estimatedDurationTooltip(sharedEngineStatus.info)}
                  >
                    Est. max per recording: {formatEstimatedDuration(sharedEngineStatus.info.estimated_max_duration_s)}
                  </span>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      {/if}
        </div>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Server &amp; diagnostics"
      description="Management mode, endpoint, health, diagnostics, and recent logs."
      variant="content"
    >
      <div data-server-diagnostics class="min-w-0 space-y-6">
        <section data-server-management class="min-w-0 space-y-2" aria-labelledby="settings-server-management-heading">
          <div class="min-w-0 px-1">
            <h3 id="settings-server-management-heading" class="text-sm font-semibold text-zinc-200">Management mode &amp; endpoint</h3>
            <p class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">Choose Eve-managed processing or connect to an external endpoint.</p>
          </div>

          <div data-server-mode-surface class="min-w-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
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

            <div class="overflow-hidden border-t border-white/[0.08]">
              {#if settings.useExternalServer}
                <div data-external-server-panel class="min-w-0 p-4">
                  <p class="text-sm text-zinc-200">Custom server endpoint</p>
                  <p class="mt-1 text-xs leading-5 text-zinc-500">
                    Set the host and port for your transcription server. Eve connects to <span class="font-mono">/transcribe</span>.
                  </p>

                  {#if externalServerError}
                    <p class="mt-3 text-xs leading-5 text-red-300 [overflow-wrap:anywhere]">{externalServerError}</p>
                  {:else}
                    <p class="mt-3 text-xs leading-5 text-zinc-500 [overflow-wrap:anywhere]">
                      Using endpoint <span class="font-mono text-zinc-300">{settings.serverUrl}</span>
                    </p>
                  {/if}

                  <div class="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                    <div class="min-w-0">
                      <label for="external-server-host" class="mb-1 block text-xs text-zinc-500">Host</label>
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
                        class="min-h-9 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-mono text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
                        placeholder="localhost"
                      />
                    </div>

                    <div class="min-w-0">
                      <label for="external-server-port" class="mb-1 block text-xs text-zinc-500">Port</label>
                      <input
                        id="external-server-port"
                        type="text"
                        value={externalServerPort}
                        oninput={(e) => {
                          externalServerPort = e.currentTarget.value;
                          updateExternalServerUrl();
                        }}
                        class="min-h-9 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-mono text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
                        placeholder="51717"
                      />
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        </section>

        <ServerView embedded externalMode={externalMode} />
      </div>
    </SettingsSection>

    <SettingsSection title="About">
      <SettingsRow label="Version" description="Installed Eve build version">
        <button
          type="button"
          onclick={copyVersionToClipboard}
          title="Click to copy version"
          class="inline-flex min-h-9 items-center justify-center rounded-lg bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
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
</PrimaryPage>

<HotkeyCaptureModal
  isOpen={isHotkeyModalOpen}
  onCapture={handleHotkeyCapture}
  onCancel={handleHotkeyCancel}
/>
