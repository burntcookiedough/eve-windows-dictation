<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsGroup from '../components/SettingsGroup.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import SettingsSkeleton from '../components/SettingsSkeleton.svelte';
  import PrimaryPage from '../components/PrimaryPage.svelte';
  import EveDropdown, { type EveDropdownOption } from '../components/EveDropdown.svelte';
  import HotkeyCaptureModal from '../components/HotkeyCaptureModal.svelte';
  import SettingsBottomSheet from '../components/SettingsBottomSheet.svelte';
  import SpeechModelSelectionSheet from '../components/SpeechModelSelectionSheet.svelte';
  import ServerView from './ServerView.svelte';
  import { hasPendingCompatibilityChanges, presetMatchesReadyEngine, presetPatch, speechModelPresetsFromCatalog, stagedPresetFromPending, type SpeechModelPreset } from '../speech-model-presets';
  import { serverStatusState } from '../server-status';
  import {
    recoverInterruptedManagedPreparation,
    serverSettingsStateKey,
    shouldClearServerSettings,
    shouldRetryServerSettings,
  } from '../server-settings-recovery';
  import { optionsForDraftWhisperDevice } from '../server-setting-options';
  import {
    clearAppliedEngineSettings,
    enginePreparationPhase,
    engineSettingsPatchMatches,
    mergeEngineSettingsPatch,
    shouldDisableEngineRevert,
    shouldRefreshCommittedSettings,
  } from '../engine-settings-transaction';
  import { toast } from '$lib/toast.svelte';
  import { DEFAULT_SETTINGS, type Settings, type Hotkey, type EngineStatus, type GpuPackState, type ModelCatalogItem, type ServerSetting, type ServerSettingOption } from '$shared/types';
  import { HOTWORDS_WARNING_THRESHOLD, formatHotwordsCsl, parseHotwordsCsl } from '$shared/hotwords';

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
  const WHISPER_LANGUAGE_AUTO_VALUE = '__whisper_language_auto__';
  const whisperLanguageNames = new Intl.DisplayNames(undefined, { type: 'language' });
  const ACTIVATION_OPTIONS = [
    { value: true, label: 'hold' },
    { value: false, label: 'toggle' },
  ] satisfies readonly { value: boolean; label: string }[];

  interface Props {
    onReplayIntro?: () => void;
  }

  let { onReplayIntro = () => {} }: Props = $props();

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
  let gpuPackState = $state<GpuPackState | null>(null);
  let gpuPackOperating = $state(false);
  let gpuPackActionError = $state('');

  let hotwordEntries = $derived(parseHotwordsCsl(settings.hotwordsCsl));
  let hotwordCount = $derived(hotwordEntries.length);
  let hasHotwordOverflowWarning = $derived(hotwordCount > HOTWORDS_WARNING_THRESHOLD);
  let activeSheet = $state<'model' | 'vocabulary' | 'removeGpuPack' | null>(null);
  let vocabularyDraft = $state('');
  let vocabularyEnabledDraft = $state(false);
  let vocabularyEntries = $derived(parseHotwordsCsl(vocabularyDraft));
  let vocabularyCount = $derived(vocabularyEntries.length);
  let vocabularyHasOverflowWarning = $derived(vocabularyCount > HOTWORDS_WARNING_THRESHOLD);
  let serverRestarting = $state(false);

  // Server/engine settings state
  let serverSettings = $state<Record<string, ServerSetting<unknown>> | null>(null);
  let modelCatalog = $state<ModelCatalogItem[]>([]);
  let engineStatus = $state<EngineStatus | null>(null);
  let serverConnected = $state(false);
  let serverSettingsLoading = $state(false);
  let lastServerSettingsAttemptKey = $state<string | null>(null);
  let engineApplying = $state(false);
  let enginePreparationRequested = $state(false);
  let enginePreparationActive = $state(false);
  let enginePreparationObserved = $state(false);
  let enginePreparationPatch = $state<Record<string, unknown>>({});
  let refreshingCommittedSettings = $state(false);
  let engineApplyError = $state('');

  // Local engine settings (track pending changes before apply)
  let pendingEngine = $state<Record<string, unknown>>({});
  let sharedServerState = $derived($serverStatusState.state);
  let sharedEngineStatus = $derived(engineStatus ?? sharedServerState?.engineStatus ?? null);
  let currentRuntimeSummary = $derived(
    sharedServerState?.status === 'running' && sharedServerState.runtime
      ? sharedServerState.runtime.effective_device === 'cuda'
        ? 'GPU active'
        : sharedServerState.runtime.effective_device === 'cpu'
          ? 'CPU active'
          : 'Active device not reported'
      : 'Available when the server is running'
  );
  let reportedRuntimeSummary = $derived(
    sharedServerState?.status !== 'running'
      ? ''
      : sharedServerState.runtime?.effective_device === 'cuda'
        ? 'GPU inference active'
        : sharedServerState.runtime?.effective_device === 'cpu'
          ? 'CPU inference active'
          : ''
  );
  let speechModelPresets = $derived(speechModelPresetsFromCatalog(modelCatalog));

  // Derive current values (server value overridden by pending)
  function getSettingValue<T>(key: string): T | undefined {
    if (key in pendingEngine) return pendingEngine[key] as T;
    const setting = serverSettings?.[key];
    return setting?.value as T | undefined;
  }

  let draftWhisperDevice = $derived(getSettingValue<string>('whisper_device') ?? 'auto');
  let selectedPreset = $derived(speechModelPresets.find((preset) =>
    getSettingValue<string>('whisper_model') === preset.model
  ) ?? null);
  let stagedPreset = $derived(stagedPresetFromPending(pendingEngine, speechModelPresets));
  let preparationFailed = $derived(
    enginePreparationPhase(sharedEngineStatus) === 'failed' ||
    (!enginePreparationActive && stagedPreset !== null && sharedServerState?.modelDownload?.model === stagedPreset.model && sharedServerState.modelDownload.status === 'error')
  );
  let engineRevertDisabled = $derived(shouldDisableEngineRevert(enginePreparationActive));
  let engineFailureMessage = $derived(
    engineApplyError ||
    (sharedEngineStatus?.status === 'error' ? sharedEngineStatus.message ?? 'Speech engine setup failed.' : '') ||
    (sharedServerState?.status === 'error' ? sharedServerState.error ?? 'Speech server failed.' : '') ||
    (sharedServerState?.modelDownload?.status === 'error' ? sharedServerState.modelDownload.detail ?? 'Speech model preparation failed.' : '') ||
    (preparationFailed ? 'Speech model preparation failed. Retry or revert the selected model.' : '')
  );
  let enginePendingMessage = $derived(
    stagedPreset
      ? enginePreparationActive || engineApplying
        ? `Preparing ${stagedPreset.label}; the current engine remains active.`
        : `${stagedPreset.label} is selected and waiting to be applied.`
      : enginePreparationActive || engineApplying || sharedEngineStatus?.status === 'loading' || !!sharedEngineStatus?.pending
        ? sharedEngineStatus?.pending?.message ?? 'Speech model is preparing.'
        : ''
  );
  let speechModelNeedsAttention = $derived(
    stagedPreset !== null || preparationFailed || (!!engineFailureMessage && Object.keys(pendingEngine).length === 0)
  );
  let advancedSettingsNeedAttention = $derived(
    hasPendingCompatibilityChanges(pendingEngine, stagedPreset) ||
    (!!engineFailureMessage && Object.keys(pendingEngine).length > 0 && stagedPreset === null)
  );
  let gpuPackNeedsAttention = $derived(gpuPackState?.status === 'failed' || !!gpuPackActionError);
  let serverDiagnosticsNeedAttention = $derived(sharedServerState?.status === 'error');
  let canRestartServer = $derived(
    !serverRestarting && sharedServerState?.managed === true && sharedServerState.status === 'running'
  );
  let serverStatusLabel = $derived(
    sharedServerState?.status === 'running'
      ? sharedEngineStatus?.status === 'ready' && !sharedEngineStatus.pending
        ? 'running · speech ready'
        : sharedEngineStatus?.status === 'loading' || sharedEngineStatus?.pending
          ? 'running · preparing speech'
          : sharedEngineStatus?.status === 'error'
            ? 'running · speech needs attention'
            : 'running'
      : sharedServerState?.status === 'starting'
        ? 'starting'
        : sharedServerState?.status === 'stopping'
          ? 'stopping'
          : sharedServerState?.status === 'error'
            ? 'needs attention'
            : 'not connected'
  );
  let inputDeviceSummary = $derived(
    audioDeviceError
      ? 'Microphone unavailable'
      : inputDevices.find((device) => device.id === settings.selectedDeviceId)?.label ?? 'Default input'
  );
  let dictationModeSummary = $derived(
    DICTATION_MODE_OPTIONS.find((option) => option.value === settings.dictationMode)?.label ?? settings.dictationMode
  );
  let speechModelSummary = $derived(
    preparationFailed
      ? 'Needs attention'
      : stagedPreset
        ? `Pending · ${stagedPreset.label}`
        : selectedPreset?.label ?? String(
            getSettingValue<string>('whisper_model') ??
            sharedEngineStatus?.info?.model ??
            (serverConnected ? 'Loading…' : 'Not connected')
          )
  );
  let advancedSettingsSummary = $derived(
    !serverConnected
      ? 'Server not connected'
      : !serverSettings
        ? 'Loading settings…'
        : `Device ${getSettingValue<string>('whisper_device') ?? 'auto'} · Precision ${getSettingValue<string>('whisper_compute_type') ?? 'default'}`
  );
  let gpuPackSummary = $derived(
    gpuPackActionError
      ? 'GPU setup failed'
      : !gpuPackState
        ? 'Checking…'
        : gpuPackState.status === 'unavailable'
          ? 'Unavailable · CPU remains available'
          : gpuPackState.status === 'missing'
            ? 'Not installed · CPU remains available'
            : gpuPackState.status === 'downloading'
              ? `Downloading · ${getGpuPackProgress(gpuPackState)}%`
              : gpuPackState.status === 'validating'
                ? 'Verifying files…'
                : gpuPackState.status === 'ready'
                  ? sharedServerState?.runtime?.pack_id === gpuPackState.packId
                    ? sharedServerState.runtime?.effective_device === 'cuda'
                      ? 'Installed · GPU active'
                      : 'Installed · CPU fallback'
                    : 'Installed · restart Eve to use'
                  : gpuPackState.code === 'busy'
                    ? 'In use · cannot modify'
                    : gpuPackState.code === 'insufficient_space'
                      ? 'Insufficient space'
                      : gpuPackState.retryable
                        ? 'Setup failed · retry available'
                        : 'GPU setup failed'
  );
  let serverDiagnosticsSummary = $derived(
    sharedServerState?.status === 'running'
      ? sharedEngineStatus?.status === 'ready'
        ? 'Running · speech ready'
        : sharedEngineStatus?.status === 'loading'
          ? 'Running · preparing speech'
          : 'Running'
      : sharedServerState?.status === 'starting'
        ? 'Starting'
        : sharedServerState?.status === 'stopping'
          ? 'Stopping'
          : sharedServerState?.status === 'error'
            ? 'Needs attention'
            : 'Not connected'
  );

  // Whether the current engine supports hotwords, as reported by the server.
  let hotwordsSupported = $derived(sharedEngineStatus?.info?.supports_hotwords ?? true);
  let hotwordsSummary = $derived(
    !hotwordsSupported
      ? 'Unavailable for current model'
      : `${settings.hotwordsEnabled ? 'On' : 'Off'} · ${hotwordCount} ${hotwordCount === 1 ? 'term' : 'terms'}`
  );

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

  function whisperLanguageLabel(code: string): string {
    try {
      const label = whisperLanguageNames.of(code);
      return label ? `${label} (${code})` : code;
    } catch {
      return code;
    }
  }

  function toDropdownOptions(
    options: Array<ServerSettingOption<unknown>>,
    mapLabelAndValue?: (option: ServerSettingOption<unknown>) => Pick<EveDropdownOption, 'value' | 'label'>,
  ): EveDropdownOption[] {
    return options.map((option) => {
      const mapped = mapLabelAndValue?.(option);
      return {
        value: mapped?.value ?? String(option.value),
        label: mapped?.label ?? option.label,
        disabled: option.disabled,
        description: option.reason,
      };
    });
  }

  function toWhisperLanguageOptions(): EveDropdownOption[] {
    const options = [...getOptions('whisper_language')];
    const currentValue = getSettingValue<unknown>('whisper_language');
    if (options.length === 0) options.push({ value: null, label: 'Auto detect' });
    if (
      typeof currentValue === 'string'
      && currentValue.trim().length > 0
      && !options.some((option) => option.value === currentValue)
    ) {
      options.push({ value: currentValue, label: currentValue, disabled: true });
    }

    return toDropdownOptions(options, (option) => {
      if (option.value === null) {
        return { value: WHISPER_LANGUAGE_AUTO_VALUE, label: 'Auto detect' };
      }
      const code = String(option.value);
      return { value: code, label: whisperLanguageLabel(code) };
    });
  }

  function whisperLanguageDropdownValue(): string {
    const value = getSettingValue<unknown>('whisper_language');
    return value === null || value === undefined ? WHISPER_LANGUAGE_AUTO_VALUE : String(value);
  }

  function selectWhisperLanguage(value: string): void {
    updateEngineSetting(
      'whisper_language',
      value === WHISPER_LANGUAGE_AUTO_VALUE ? null : value,
    );
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

  function formatGpuPackSize(bytes: number): string {
    const mib = bytes / (1024 * 1024);
    return `${bytes.toLocaleString()} bytes (${mib.toFixed(0)} MiB)`;
  }

  function getGpuPackProgress(state: Extract<GpuPackState, { status: 'downloading' }>): number {
    if (state.totalBytes <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((state.receivedBytes / state.totalBytes) * 100)));
  }

  async function installGpuPack(): Promise<void> {
    if (gpuPackOperating) return;
    gpuPackOperating = true;
    gpuPackActionError = '';
    try {
      gpuPackState = await window.murmurMain.installGpuPack();
    } catch {
      gpuPackState = { status: 'failed', code: 'storage_failed', retryable: true };
      gpuPackActionError = 'GPU support could not be installed. Try again.';
    } finally {
      gpuPackOperating = false;
    }
  }

  async function repairGpuPack(): Promise<void> {
    if (gpuPackOperating) return;
    gpuPackOperating = true;
    gpuPackActionError = '';
    try {
      gpuPackState = await window.murmurMain.repairGpuPack();
    } catch {
      gpuPackState = { status: 'failed', code: 'storage_failed', retryable: true };
      gpuPackActionError = 'GPU support could not be repaired. Try again.';
    } finally {
      gpuPackOperating = false;
    }
  }

  function promptRemoveGpuPack(): void {
    if (gpuPackOperating) return;
    gpuPackActionError = '';
    activeSheet = 'removeGpuPack';
  }

  async function confirmRemoveGpuPack(): Promise<void> {
    if (gpuPackOperating) return;
    gpuPackOperating = true;
    gpuPackActionError = '';
    try {
      closeSettingsSheet();
      gpuPackState = await window.murmurMain.removeGpuPack();
    } catch {
      gpuPackState = { status: 'failed', code: 'storage_failed', retryable: true };
      gpuPackActionError = 'GPU support could not be removed. Try again.';
    } finally {
      gpuPackOperating = false;
    }
  }

  async function loadCoreSettings() {
    try {
      const loadedSettings = await window.murmurMain.getSettings();
      settings = loadedSettings;
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
      modelCatalog = serverData.model_catalog ?? [];
      engineStatus = serverData.engine_status;
      serverConnected = true;
      return true;
    } catch {
      serverSettings = null;
      modelCatalog = [];
      engineStatus = null;
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
    let active = true;
    let gpuPackEventRevision = 0;
    const removeGpuPackListener = window.murmurMain.onGpuPackStateChange((state) => {
      if (!active) return;
      gpuPackEventRevision += 1;
      gpuPackState = state;
    });
    const initialGpuPackEventRevision = gpuPackEventRevision;
    void window.murmurMain.getGpuPackState()
      .then((state) => {
        if (active && gpuPackEventRevision === initialGpuPackEventRevision) {
          gpuPackState = state;
        }
      })
      .catch(() => {
        if (active && gpuPackEventRevision === initialGpuPackEventRevision) {
          gpuPackState = { status: 'failed', code: 'storage_failed', retryable: true };
        }
      });

    void loadCoreSettings();
    void loadServerSettings();
    void loadAudioDevices();
    void window.murmurMain.getAppVersion()
      .then((version) => (appVersion = version))
      .catch((error) => console.error('Failed to load app version:', error));

    return () => {
      active = false;
      removeGpuPackListener();
    };
  });

  $effect(() => {
    const state = sharedServerState;
    if (shouldClearServerSettings(state)) {
      const recovery = recoverInterruptedManagedPreparation(state, {
        pending: pendingEngine,
        requested: enginePreparationRequested,
        active: enginePreparationActive,
        observed: enginePreparationObserved,
        applying: engineApplying,
      });
      serverSettings = null;
      modelCatalog = [];
      engineStatus = null;
      serverConnected = false;
      lastServerSettingsAttemptKey = null;
      if (recovery) {
        pendingEngine = recovery.pending;
        enginePreparationRequested = recovery.requested;
        enginePreparationActive = recovery.active;
        enginePreparationObserved = recovery.observed;
        enginePreparationPatch = {};
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
    vocabularyDraft = value;
    hotwordsFileMessage = '';
  }

  function openModelSheet(): void {
    activeSheet = 'model';
  }

  function openVocabularySheet(): void {
    vocabularyDraft = settings.hotwordsCsl;
    vocabularyEnabledDraft = settings.hotwordsEnabled;
    hotwordsFileMessage = '';
    activeSheet = 'vocabulary';
  }

  function closeSettingsSheet(): void {
    activeSheet = null;
  }

  function saveVocabulary(): void {
    updateSetting('hotwordsCsl', formatHotwordsCsl(parseHotwordsCsl(vocabularyDraft)));
    updateSetting('hotwordsEnabled', vocabularyEnabledDraft);
    closeSettingsSheet();
  }

  async function restartServer(): Promise<void> {
    if (!canRestartServer) return;
    serverRestarting = true;
    try {
      await window.murmurMain.restartServer();
    } catch {
      toast('Eve could not restart the speech server', 'error');
    } finally {
      serverRestarting = false;
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

  async function exportHotwords(value = vocabularyDraft) {
    const ok = await window.murmurMain.exportHotwordsToFile(value);
    hotwordsFileMessage = ok ? 'Exported hotwords list' : 'Export canceled';
  }

  async function copyVersionToClipboard() {
    const versionLabel = `v${appVersion}`;
    try {
      await window.murmurMain.copyToClipboard(versionLabel);
      toast(`Copied ${versionLabel}`);
    } catch {
      toast('Could not copy the version', 'error');
    }
  }

  function updateEngineSetting(key: string, value: unknown) {
    pendingEngine = { ...pendingEngine, [key]: value };
  }

  function selectPreset(preset: SpeechModelPreset): void {
    const patch = presetPatch(preset);
    pendingEngine = mergeEngineSettingsPatch(pendingEngine, patch);
    engineApplyError = '';
    void applyEngineSettings(patch);
  }

  function revertEngineSettings(): void {
    if (enginePreparationActive) return;
    pendingEngine = {};
    enginePreparationRequested = false;
    enginePreparationActive = false;
    enginePreparationObserved = false;
    enginePreparationPatch = {};
    engineApplyError = '';
    void loadServerSettings();
  }

  async function applyEngineSettings(requestedPatch: Record<string, unknown> = pendingEngine) {
    if (engineApplying || enginePreparationActive || Object.keys(requestedPatch).length === 0) return;
    enginePreparationRequested = false;
    enginePreparationObserved = false;
    enginePreparationPatch = {};
    engineApplying = true;
    engineApplyError = '';

    try {
      // Svelte $state objects are Proxies; IPC requires plain cloneable values.
      const patch = Object.fromEntries(Object.entries(requestedPatch));
      const response = await window.murmurMain.updateServerSettings(patch);
      serverSettings = response.settings;
      modelCatalog = response.model_catalog ?? [];
      engineStatus = response.engine_status;
      if (response.reload_started) {
        enginePreparationPatch = patch;
        enginePreparationRequested = true;
        enginePreparationActive = true;
        enginePreparationObserved = response.engine_status.status === 'loading' || !!response.engine_status.pending;
        if (!enginePreparationObserved) {
          await confirmEnginePreparationStatus();
        }
      } else if (response.engine_status.status === 'ready' && !response.engine_status.pending) {
        if (engineSettingsPatchMatches(patch, serverSettings)) {
          pendingEngine = clearAppliedEngineSettings(pendingEngine, patch);
        }
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
      if (!engineSettingsPatchMatches(enginePreparationPatch, serverSettings)) return;
      pendingEngine = clearAppliedEngineSettings(pendingEngine, enginePreparationPatch);
      enginePreparationRequested = false;
      enginePreparationActive = false;
      enginePreparationObserved = false;
      enginePreparationPatch = {};
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
        if (!engineSettingsPatchMatches(enginePreparationPatch, serverSettings)) return;
        pendingEngine = clearAppliedEngineSettings(pendingEngine, enginePreparationPatch);
        enginePreparationRequested = false;
        enginePreparationActive = false;
        enginePreparationObserved = false;
        enginePreparationPatch = {};
        engineApplyError = '';
      }
    } finally {
      refreshingCommittedSettings = false;
    }
  }
</script>

<PrimaryPage page="settings" scrollOwner="settings-page" contentClass="pb-6">
  <div class="settings-view">
    {#if settingsLoaded}
      <header class="settings-page-header" data-r style="--r: 0">
        <h1>Settings</h1>
        <span class="settings-mono">saved as you go</span>
      </header>

      <SettingsSection title="Dictation" id="settings-dictation" revealOrder={1}>
        <SettingsRow label="Quick" description="Start or stop quick dictation. Click to record a new hotkey.">
          <button type="button" class="settings-link settings-hotkey" onclick={() => openHotkeyCapture('quick')}>
            {hotkeyDisplayName}
          </button>
          {#if isHotkeyChanged}
            <button type="button" class="settings-link settings-secondary-link" onclick={resetHotkey} aria-label="Reset quick hotkey to Ctrl+Win">reset</button>
          {/if}
        </SettingsRow>
        <SettingsRow label="Long" description="Start or stop long dictation. Click to record a new hotkey.">
          <button type="button" class="settings-link settings-hotkey" onclick={() => openHotkeyCapture('long')}>
            {longHotkeyDisplayName}
          </button>
          {#if isLongHotkeyChanged}
            <button type="button" class="settings-link settings-secondary-link" onclick={resetLongHotkey} aria-label="Reset long hotkey to Ctrl+Shift+Win">reset</button>
          {/if}
        </SettingsRow>
        <SettingsRow label="Shortcut" description="Choose hold-to-talk or toggle activation.">
          <div class="settings-segments" role="group" aria-label="Shortcut activation">
            {#each ACTIVATION_OPTIONS as option}
              <button
                type="button"
                class="settings-segment"
                class:selected={settings.holdToTalk === option.value}
                aria-pressed={settings.holdToTalk === option.value}
                onclick={() => updateSetting('holdToTalk', option.value)}
              >{option.label}</button>
            {/each}
          </div>
        </SettingsRow>
        <SettingsRow label="Microphone" description={audioDeviceError || 'Select the microphone used for recording.'}>
          <EveDropdown
            label="Input device"
            value={settings.selectedDeviceId}
            options={inputDevices.map((device) => ({ value: device.id, label: device.label }))}
            onchange={(value) => updateSetting('selectedDeviceId', value)}
            disabled={isLoadingDevices}
            class="settings-device-dropdown"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Output" id="settings-output" revealOrder={2}>
        <SettingsRow label="Style" description="Choose how Eve prepares each transcription.">
          <EveDropdown
            label="Dictation mode"
            value={settings.dictationMode}
            options={DICTATION_MODE_OPTIONS}
            onchange={(value) => updateSetting('dictationMode', value as Settings['dictationMode'])}
          />
        </SettingsRow>
        <SettingsRow label="Append" description="Choose whether to add a period or trailing space.">
          <div class="settings-segments" role="group" aria-label="Append punctuation and spacing">
            <button type="button" class="settings-segment" class:selected={settings.appendPeriod} aria-pressed={settings.appendPeriod} onclick={() => updateSetting('appendPeriod', !settings.appendPeriod)}>period</button>
            <button type="button" class="settings-segment" class:selected={settings.appendSpace} aria-pressed={settings.appendSpace} onclick={() => updateSetting('appendSpace', !settings.appendSpace)}>space</button>
          </div>
        </SettingsRow>
        <SettingsRow label="Afterwards" description="Choose which output actions Eve performs after dictation.">
          <div class="settings-segments" role="group" aria-label="After dictation actions">
            <button type="button" class="settings-segment" class:selected={settings.autoCopy} aria-pressed={settings.autoCopy} onclick={() => updateSetting('autoCopy', !settings.autoCopy)}>copy</button>
            <button type="button" class="settings-segment" class:selected={settings.autoPaste} aria-pressed={settings.autoPaste} onclick={() => updateSetting('autoPaste', !settings.autoPaste)}>paste</button>
            <button type="button" class="settings-segment" class:selected={settings.restoreClipboardAfterPaste} aria-pressed={settings.restoreClipboardAfterPaste} onclick={() => updateSetting('restoreClipboardAfterPaste', !settings.restoreClipboardAfterPaste)}>restore</button>
          </div>
        </SettingsRow>
        <SettingsRow label="Vocabulary" description="Edit custom recognition terms, or import and export them.">
          <button type="button" class="settings-link settings-value-link" onclick={openVocabularySheet}>
            {hotwordsSupported ? (settings.hotwordsEnabled ? hotwordCount + ' terms' : 'off') : 'unavailable'} <span class="settings-chevron" aria-hidden="true">›</span>
          </button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Engine" id="settings-engine" revealOrder={3}>
        <SettingsRow label="Speech model" description="Choose and prepare a speech model.">
          <button type="button" class="settings-link settings-model-link" onclick={openModelSheet}>
            <span>{speechModelSummary}</span><span class="settings-chevron" aria-hidden="true">›</span>
          </button>
        </SettingsRow>
        <SettingsRow label="Server" description={serverStatusLabel}>
          <div class="settings-server-inline" data-state={$serverStatusState.phase}>
            <span class="settings-state-mark" aria-hidden="true"></span>
            <span>{serverStatusLabel}</span>
            <button type="button" class="settings-link settings-secondary-link settings-server-restart" onclick={restartServer} disabled={!canRestartServer} aria-label="Restart managed speech server">
              {serverRestarting ? 'restarting…' : 'restart'}
            </button>
          </div>
        </SettingsRow>
        {#if engineFailureMessage}
          <p data-settings-readiness role="alert" class="settings-engine-message" data-state="error">{engineFailureMessage}</p>
        {:else if enginePendingMessage}
          <p data-settings-readiness class="settings-engine-message" data-state="pending">{enginePendingMessage}</p>
        {/if}

        <SettingsGroup
          title="Advanced"
          id="advanced-settings-heading"
          variant="content"
          collapsible
          summary={advancedSettingsSummary}
          open={advancedSettingsNeedAttention}
        >
          <div data-advanced-settings class="settings-advanced">
            {#if !serverConnected}
              <p class="settings-note">Server settings are unavailable until the speech server connects.</p>
            {:else if !serverSettings}
              <p class="settings-note">Loading engine settings…</p>
            {:else}
              <div id="compatibility-controls" data-compatibility-controls>
                {#if serverSettings.whisper_model}
                  <SettingsRow label={serverSettings.whisper_model.label} description="Raw compatibility model selection.">
                    <EveDropdown
                      label={serverSettings.whisper_model.label}
                      value={String(getSettingValue('whisper_model') ?? serverSettings.whisper_model.value)}
                      options={toDropdownOptions(getOptions('whisper_model'))}
                      onchange={(value) => updateEngineSetting('whisper_model', value)}
                    />
                  </SettingsRow>
                {/if}
                {#if serverSettings.whisper_device && isVisible(serverSettings.whisper_device)}
                  <SettingsRow label="Device" description="Hardware device used for speech inference.">
                    <EveDropdown
                      label="Whisper device"
                      value={String(getSettingValue('whisper_device') ?? serverSettings.whisper_device.value)}
                      options={toDropdownOptions(getOptions('whisper_device'))}
                      onchange={(value) => updateEngineSetting('whisper_device', value)}
                    />
                  </SettingsRow>
                {/if}
                {#if serverSettings.whisper_compute_type}
                  <SettingsRow label="Precision" description={serverSettings.whisper_compute_type.description ?? 'Numeric precision used by the speech engine.'}>
                    <EveDropdown
                      label={serverSettings.whisper_compute_type.label}
                      value={String(getSettingValue('whisper_compute_type') ?? serverSettings.whisper_compute_type.value)}
                      options={toDropdownOptions(getWhisperComputeOptions())}
                      onchange={(value) => updateEngineSetting('whisper_compute_type', value)}
                    />
                  </SettingsRow>
                {/if}
                {#if serverSettings.whisper_language && isVisible(serverSettings.whisper_language)}
                  <SettingsRow label="Language" description={serverSettings.whisper_language.description ?? 'Language hint for transcription.'}>
                    <EveDropdown
                      label={serverSettings.whisper_language.label}
                      value={whisperLanguageDropdownValue()}
                      options={toWhisperLanguageOptions()}
                      onchange={selectWhisperLanguage}
                    />
                  </SettingsRow>
                {/if}
              </div>

              {#if hasPendingCompatibilityChanges(pendingEngine, stagedPreset)}
                <div data-compatibility-footer class="settings-pending-actions">
                  <p>Compatibility changes require an engine reload.</p>
                  {#if !stagedPreset}
                    <div class="settings-action-row">
                      <button type="button" class="settings-link" onclick={() => applyEngineSettings()} disabled={engineApplying || enginePreparationActive}>
                        {engineApplying || enginePreparationActive ? 'preparing…' : preparationFailed ? 'retry changes' : 'apply changes'}
                      </button>
                      <button type="button" class="settings-link settings-secondary-link" onclick={revertEngineSettings} disabled={engineApplying || engineRevertDisabled}>revert</button>
                    </div>
                  {/if}
                  {#if engineApplyError}<p role="alert" data-state="error">{engineApplyError}</p>{/if}
                </div>
              {/if}

              {#if sharedEngineStatus}
                <div data-engine-status class="settings-engine-details">
                  <div class="settings-engine-summary">
                    <span>Engine: {sharedEngineStatus.status === 'ready' && !sharedEngineStatus.pending ? 'ready' : sharedEngineStatus.status === 'error' ? 'needs attention' : 'preparing'}</span>
                    {#if sharedEngineStatus.info}
                      <span>~{sharedEngineStatus.info.model_size_gb} GB model</span>
                    {/if}
                  </div>
                  {#if sharedEngineStatus.pending?.message}<span>{sharedEngineStatus.pending.message}</span>{/if}
                  {#if sharedEngineStatus.message}<span>{sharedEngineStatus.message}</span>{/if}
                  {#if sharedEngineStatus.info}
                    {#if sharedEngineStatus.info.gpu_vram_gb != null}
                      <span title={sharedEngineStatus.info.gpu_name ?? 'GPU'}>{sharedEngineStatus.info.gpu_name ?? 'GPU'} · {sharedEngineStatus.info.gpu_vram_gb.toFixed(1)} GB VRAM</span>
                    {/if}
                    {#if sharedEngineStatus.info.estimated_max_duration_s != null}
                      <span title={estimatedDurationTooltip(sharedEngineStatus.info)}>Estimated max recording: {formatEstimatedDuration(sharedEngineStatus.info.estimated_max_duration_s)}</span>
                    {/if}
                  {/if}
                </div>
              {/if}
            {/if}

            <SettingsRow label="Paste method" description="Choose how Eve sends the transcription to the active app.">
              <EveDropdown
                label="Paste method"
                value={settings.pasteMethod}
                options={PASTE_METHOD_OPTIONS}
                onchange={(value) => updateSetting('pasteMethod', value as Settings['pasteMethod'])}
              />
            </SettingsRow>
            <SettingsRow label="Auto-start server" description="Automatically start the built-in speech server when Eve launches.">
              <Toggle enabled={settings.serverAutoStart} onchange={(value) => updateSetting('serverAutoStart', value)} label="Auto-start server" />
            </SettingsRow>

            <div data-gpu-pack-card class="settings-gpu-support">
              <div class="settings-gpu-heading">
                <span>Optional GPU support</span>
                {#if gpuPackState?.status === 'downloading'}
                  <span>{getGpuPackProgress(gpuPackState)}%</span>
                {:else if gpuPackState?.status === 'missing'}
                  <button
                    type="button"
                    data-gpu-pack-action
                    class="settings-link settings-gpu-action"
                    onclick={installGpuPack}
                    disabled={gpuPackOperating}
                    aria-busy={gpuPackOperating}
                  >
                    {gpuPackOperating ? 'starting…' : 'download GPU support'}
                  </button>
                {:else if gpuPackState?.status === 'ready'}
                  <div class="settings-gpu-actions">
                    <button
                      type="button"
                      data-gpu-pack-repair
                      class="settings-link settings-gpu-action"
                      onclick={repairGpuPack}
                      disabled={gpuPackOperating}
                      aria-busy={gpuPackOperating}
                    >
                      {gpuPackOperating ? 'working…' : 'repair'}
                    </button>
                    <button
                      type="button"
                      data-gpu-pack-remove
                      class="settings-link settings-gpu-action"
                      onclick={promptRemoveGpuPack}
                      disabled={gpuPackOperating}
                      aria-busy={gpuPackOperating}
                    >
                      remove
                    </button>
                  </div>
                {:else if gpuPackState?.status === 'failed' && gpuPackState.retryable}
                  <div class="settings-gpu-actions">
                    <button
                      type="button"
                      data-gpu-pack-action
                      class="settings-link settings-gpu-action"
                      onclick={installGpuPack}
                      disabled={gpuPackOperating}
                      aria-busy={gpuPackOperating}
                    >
                      {gpuPackOperating ? 'starting…' : 'try again'}
                    </button>
                      <button
                        type="button"
                        data-gpu-pack-remove
                        class="settings-link settings-gpu-action"
                        onclick={promptRemoveGpuPack}
                        disabled={gpuPackOperating}
                        aria-busy={gpuPackOperating}
                      >
                        remove
                      </button>
                  </div>
                {/if}
              </div>
              <p data-gpu-pack-status>
                {#if !gpuPackState}
                  Checking GPU support…
                {:else if gpuPackState.status === 'unavailable'}
                  GPU support is unavailable; CPU remains available.
                {:else if gpuPackState.status === 'missing'}
                  CUDA support is not installed; CPU remains available.
                {:else if gpuPackState.status === 'downloading'}
                  Downloading {formatGpuPackSize(gpuPackState.receivedBytes)} of {formatGpuPackSize(gpuPackState.totalBytes)}.
                {:else if gpuPackState.status === 'validating'}
                  Verifying downloaded GPU files…
                {:else if gpuPackState.status === 'ready'}
                  {sharedServerState?.runtime?.pack_id === gpuPackState.packId
                    ? sharedServerState.runtime?.effective_device === 'cuda'
                      ? 'Installed · GPU active.'
                      : 'Installed · CPU fallback is active. Your device preference is unchanged.'
                    : 'Installed · restart the speech server to use GPU support.'}
                {:else if gpuPackState.code === 'busy'}
                  Another operation or running speech server is using GPU support. Stop the server through its owner, then retry.
                {:else if gpuPackState.code === 'insufficient_space'}
                  Not enough disk space to install GPU support. Free space on the application data drive, then retry.
                {:else if gpuPackState.code === 'space_unknown'}
                  Could not verify available disk space. Check that application storage is available, then retry.
                {:else if gpuPackState.code === 'integrity_failed' || gpuPackState.code === 'pack_invalid'}
                  GPU files did not pass integrity checks.
                {:else if gpuPackState.code === 'download_failed'}
                  The GPU support download was interrupted.
                {:else}
                  Eve could not verify GPU support.
                {/if}
              </p>
              {#if gpuPackState?.status === 'downloading'}
                <progress value={getGpuPackProgress(gpuPackState)} max="100" aria-label="GPU support download progress"></progress>
              {/if}
              {#if gpuPackActionError}<p role="alert">{gpuPackActionError}</p>{/if}
              <p class="settings-note">Runtime: {currentRuntimeSummary}. Installing support does not change the selected device.</p>
            </div>

            <SettingsGroup
              title="Diagnostics"
              variant="content"
              collapsible
              summary={serverDiagnosticsSummary}
              open={serverDiagnosticsNeedAttention}
            >
              <div data-server-diagnostics class="settings-diagnostics">
                <ServerView embedded showAutoStart={false} />
              </div>
            </SettingsGroup>
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="App" id="settings-app" revealOrder={4}>
        <SettingsRow label="Open at login" description="Start Eve when you sign in to Windows.">
          <Toggle enabled={settings.launchOnBoot} onchange={(value) => void updateLaunchOnBoot(value)} label="Open at login" />
        </SettingsRow>
        <SettingsRow label="Start in tray" description="Open Eve minimized to the system tray.">
          <Toggle enabled={settings.startMinimized} onchange={(value) => updateSetting('startMinimized', value)} label="Start in tray" />
        </SettingsRow>
        <SettingsRow label="Appearance" description="Choose a dark or light window theme.">
          <div class="settings-segments" role="group" aria-label="Appearance">
            <button type="button" class="settings-segment" class:selected={settings.appearance === 'dark'} aria-pressed={settings.appearance === 'dark'} onclick={() => updateSetting('appearance', 'dark')}>dark</button>
            <button type="button" class="settings-segment" class:selected={settings.appearance === 'light'} aria-pressed={settings.appearance === 'light'} onclick={() => updateSetting('appearance', 'light')}>light</button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <footer data-settings-about class="settings-footer" data-r style="--r: 5">
        <span class="settings-mono">EVE · v{appVersion}</span>
        <button type="button" class="settings-link" onclick={copyVersionToClipboard} aria-label={'Copy Eve version ' + appVersion}>copy version</button>
        <span class="settings-footer-spacer"></span>
        <button type="button" class="settings-link" onclick={onReplayIntro}>replay intro</button>
      </footer>
    {:else}
      <SettingsSkeleton />
    {/if}
  </div>
</PrimaryPage>

<SpeechModelSelectionSheet
  open={activeSheet === 'model'}
  serverAvailable={serverConnected && serverSettings !== null}
  presets={speechModelPresets}
  selected={selectedPreset}
  selectedNeedsApply={stagedPreset !== null && !presetMatchesReadyEngine(stagedPreset, sharedEngineStatus)}
  engineStatus={sharedEngineStatus}
  modelDownload={sharedServerState?.modelDownload}
  {preparationFailed}
  preparationActive={enginePreparationActive}
  applying={engineApplying}
  canRevert={stagedPreset !== null}
  revertDisabled={engineApplying || engineRevertDisabled}
  errorMessage={engineApplyError}
  onClose={closeSettingsSheet}
  onUse={selectPreset}
  onRevert={revertEngineSettings}
/>

<SettingsBottomSheet
  open={activeSheet === 'vocabulary'}
  title="Vocabulary"
  description="Names and terms Eve should recognize. Use one term per line."
  onClose={closeSettingsSheet}
>
  {#if activeSheet === 'vocabulary'}
    {#if !hotwordsSupported}
      <p class="settings-note" role="status">Vocabulary hints are unavailable for the current speech model.</p>
    {/if}
    <label for="settings-vocabulary" class="settings-sheet-label">Vocabulary terms</label>
    <textarea
      id="settings-vocabulary"
      data-sheet-initial-focus={hotwordsSupported ? '' : undefined}
      value={vocabularyDraft}
      oninput={(event) => updateHotwordsCsl(event.currentTarget.value)}
      rows="7"
      disabled={!hotwordsSupported}
      aria-describedby="settings-vocabulary-help settings-vocabulary-count"
      class="settings-vocabulary-editor"
      placeholder="One term per line"
    ></textarea>
    <p id="settings-vocabulary-help" class="settings-note">Add names, acronyms, and product terms that are often transcribed incorrectly. Large lists can reduce recognition quality.</p>
    <SettingsRow label="Use vocabulary" description="Bias recognition toward the terms above.">
      <Toggle enabled={vocabularyEnabledDraft && hotwordsSupported} onchange={(value) => vocabularyEnabledDraft = value} label="Use vocabulary" disabled={!hotwordsSupported} />
    </SettingsRow>
    <p id="settings-vocabulary-count" class="settings-vocabulary-count" role="status">
      {vocabularyCount} {vocabularyCount === 1 ? 'term' : 'terms'}
      {#if vocabularyHasOverflowWarning} · Recognition quality may degrade with a long list.{/if}
    </p>
    {#if hotwordsFileMessage}<p class="settings-note" role="status">{hotwordsFileMessage}</p>{/if}
    <div class="settings-action-row settings-vocabulary-actions">
      <button type="button" class="settings-link" onclick={importHotwords} disabled={!hotwordsSupported}>import</button>
      <button type="button" class="settings-link" onclick={() => void exportHotwords()} disabled={!hotwordsSupported}>export</button>
      <span class="settings-footer-spacer"></span>
      <button type="button" class="settings-link settings-secondary-link" onclick={closeSettingsSheet}>cancel</button>
      <button type="button" class="settings-primary-action" onclick={saveVocabulary}>done</button>
    </div>
  {/if}
</SettingsBottomSheet>

<SettingsBottomSheet
  open={activeSheet === 'removeGpuPack'}
  title="Remove GPU support?"
  description="Remove downloaded GPU support files. Eve will use CPU for speech recognition until GPU support is downloaded again."
  onClose={closeSettingsSheet}
>
  {#if activeSheet === 'removeGpuPack'}
    <p class="settings-note">
      This removes local CUDA components. Your settings and downloaded models are not changed.
    </p>
    <div class="settings-action-row settings-gpu-remove-actions">
      <span class="settings-footer-spacer"></span>
      <button
        type="button"
        class="settings-link settings-secondary-link"
        onclick={closeSettingsSheet}
        disabled={gpuPackOperating}
        data-sheet-initial-focus
      >
        cancel
      </button>
      <button
        type="button"
        data-gpu-pack-confirm-remove
        class="settings-primary-action"
        onclick={confirmRemoveGpuPack}
        disabled={gpuPackOperating}
        aria-busy={gpuPackOperating}
      >
        {gpuPackOperating ? 'removing…' : 'remove'}
      </button>
    </div>
  {/if}
</SettingsBottomSheet>

<HotkeyCaptureModal
  isOpen={isHotkeyModalOpen}
  onCapture={handleHotkeyCapture}
  onCancel={handleHotkeyCancel}
/>

<style>
  .settings-view {
    min-width: 0;
    color: var(--fg, #ececec);
    font-family: "Geist", "Segoe UI Variable", sans-serif;
  }

  .settings-page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 16px 0 26px;
  }

  .settings-page-header h1 {
    margin: 0;
    color: var(--fg2, #9b9b9b);
    font-size: 12.5px;
    font-weight: 400;
    letter-spacing: 0.02em;
  }

  .settings-view :global(.settings-section):first-of-type {
    margin-top: 26px;
  }

  .settings-mono {
    color: var(--fg3, #565656);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 10.5px;
    letter-spacing: 0.04em;
    text-transform: none;
  }

  .settings-link,
  .settings-segment {
    appearance: none;
    border: 0;
    border-radius: 0;
    padding: 2px 0;
    background: transparent;
    color: var(--fg2, #9b9b9b);
    font: inherit;
    font-size: 11px;
    line-height: 1.5;
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 3px;
    cursor: pointer;
    transition: color 180ms ease, text-decoration-color 180ms ease;
  }

  .settings-link:hover:not(:disabled),
  .settings-segment:hover:not(:disabled) {
    color: var(--fg, #ececec);
    text-decoration-color: currentColor;
  }

  .settings-link:focus-visible,
  .settings-segment:focus-visible {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  .settings-link:disabled,
  .settings-segment:disabled {
    color: var(--fg3, #565656);
    cursor: not-allowed;
  }

  .settings-hotkey {
    color: var(--fg2, #9b9b9b);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 11.5px;
    letter-spacing: 0.02em;
    text-decoration-color: var(--line2, rgba(255, 255, 255, 0.14));
  }

  .settings-secondary-link {
    color: var(--fg3, #565656);
  }

  .settings-segments {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    justify-content: flex-end;
    gap: 16px;
    flex-wrap: wrap;
  }

  .settings-segment {
    position: relative;
    padding: 4px 0;
    color: var(--fg3, #565656);
    font-family: Geist, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    font-size: 12.5px;
    line-height: normal;
    letter-spacing: normal;
    text-decoration: none;
    text-transform: lowercase;
  }

  .settings-segment::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    background: var(--fg);
    transform: scaleX(0);
    transition: transform .4s var(--ease);
  }

  .settings-segment.selected::after { transform: scaleX(1); }
  .settings-segment:not(.selected):hover:not(:disabled) { color: var(--fg2); }

  .settings-segment.selected,
  .settings-segment[aria-pressed="true"] {
    color: var(--fg, #ececec);
    text-decoration-color: var(--fg2, #9b9b9b);
  }

  .settings-chevron {
    display: inline-block;
    margin-left: 3px;
    font-family: "Geist", "Segoe UI Variable", sans-serif;
    font-size: 15px;
    line-height: 0.8;
    vertical-align: -1px;
  }

  .settings-model-link {
    font-size: 13px;
    max-width: 100%;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .settings-value-link { font-size: 13px; }

  .settings-server-inline {
    display: flex;
    min-width: 0;
    max-width: 100%;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 9px;
    color: var(--fg2, #9b9b9b);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 11px;
    text-align: right;
  }

  .settings-server-inline > span:nth-child(2) {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .settings-server-inline .settings-server-restart {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .settings-state-mark {
    width: 6px;
    height: 6px;
    flex: none;
    border: 1px solid currentColor;
    border-radius: 50%;
  }

  .settings-server-inline[data-state="ready"] .settings-state-mark,
  .settings-server-inline[data-state="running"] .settings-state-mark {
    background: currentColor;
  }

  .settings-engine-message,
  .settings-note,
  .settings-vocabulary-count {
    margin: 7px 0;
    color: var(--fg2, #9b9b9b);
    font-size: 11px;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .settings-engine-message[data-state="error"] {
    color: var(--fg, #ececec);
    border-left: 1px solid var(--fg2, #9b9b9b);
    padding-left: 9px;
  }

  .settings-engine-message[data-state="pending"] {
    border-left: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    padding-left: 9px;
  }

  .settings-advanced {
    min-width: 0;
    padding-bottom: 9px;
  }

  :global(.settings-view .settings-section .settings-disclosure-summary) {
    color: var(--fg, #ececec);
    font-family: "Geist", "Segoe UI Variable", sans-serif;
    font-size: 13.5px;
    letter-spacing: normal;
    text-transform: none;
  }

  :global(.settings-view .settings-section .settings-disclosure-action) {
    color: var(--fg3, #565656);
    font-family: Geist, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    letter-spacing: normal;
    text-transform: lowercase;
  }

  .settings-pending-actions,
  .settings-engine-details,
  .settings-gpu-support,
  .settings-diagnostics {
    min-width: 0;
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.07));
    padding: 10px 0;
  }

  .settings-pending-actions p,
  .settings-engine-details span,
  .settings-gpu-support p {
    color: var(--fg2, #9b9b9b);
    font-size: 10px;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .settings-engine-details {
    display: grid;
    gap: 3px;
  }

  .settings-engine-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 3px 12px;
  }

  .settings-action-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .settings-gpu-heading {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    color: var(--fg, #ececec);
    font-size: 11px;
  }

  .settings-gpu-heading span:last-child,
  .settings-gpu-support > p,
  .settings-gpu-support .settings-note {
    color: var(--fg2, #9b9b9b);
  }

  .settings-gpu-actions {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex: none;
    margin-left: auto;
  }

  .settings-gpu-remove-actions {
    margin-top: 16px;
  }

  .settings-gpu-action {
    flex: none;
    margin-left: auto;
    color: var(--fg, #ececec);
    font-size: 11px;
    text-decoration-color: currentColor;
    white-space: nowrap;
  }

  .settings-gpu-support progress {
    display: block;
    width: 100%;
    height: 1px;
    margin: 8px 0;
    appearance: none;
    border: 0;
    background: var(--line2, rgba(255, 255, 255, 0.14));
  }

  .settings-gpu-support progress::-webkit-progress-bar {
    background: var(--line2, rgba(255, 255, 255, 0.14));
  }

  .settings-gpu-support progress::-webkit-progress-value {
    background: var(--fg2, #9b9b9b);
  }

  .settings-gpu-support progress::-moz-progress-bar {
    background: var(--fg2, #9b9b9b);
  }

  .settings-vocabulary-editor {
    display: block;
    width: 100%;
    box-sizing: border-box;
    min-height: 132px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 0;
    padding: 12px;
    background: transparent;
    color: var(--fg, #ececec);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.7;
    resize: vertical;
  }

  .settings-vocabulary-editor::placeholder {
    color: var(--fg3, #565656);
  }

  textarea.settings-vocabulary-editor:focus-visible {
    border-color: var(--fg2, #9b9b9b);
    outline: none;
  }

  .settings-sheet-label {
    display: block;
    margin-bottom: 7px;
    color: var(--fg3, #565656);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .settings-primary-action {
    min-height: 34px;
    border: 1px solid var(--fg, #ececec);
    border-radius: 0;
    padding: 7px 12px;
    background: var(--fg, #ececec);
    color: var(--bg, #0b0b0b);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .settings-primary-action:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .settings-primary-action:focus-visible {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  .settings-footer {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 44px;
    padding: 0;
  }

  .settings-footer-spacer {
    flex: 1 1 auto;
  }

  @media (max-width: 480px) {
    .settings-server-inline {
      max-width: 182px;
    }

    .settings-action-row {
      gap: 9px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .settings-link,
    .settings-segment {
      transition-duration: 1ms;
    }
  }
</style>
