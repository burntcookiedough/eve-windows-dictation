<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import HotkeyCaptureModal from '../components/HotkeyCaptureModal.svelte';
  import SettingsSkeleton from '../components/SettingsSkeleton.svelte';
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

  // Default hotkey (Ctrl+Meta)
  const DEFAULT_HOTKEY: Hotkey = DEFAULT_SETTINGS.hotkey;

  // Default long dictation hotkey (Ctrl+Shift+Meta)
  const DEFAULT_LONG_HOTKEY: Hotkey = DEFAULT_SETTINGS.longHotkey;

  // Hotkey display name (human-readable)
  let hotkeyDisplayName = $state('Ctrl+Meta');
  let longHotkeyDisplayName = $state('Ctrl+Shift+Meta');
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
  let engineAdvancedOpen = $state(false);
  let engineApplying = $state(false);
  let availableEngines = $state<string[]>([]);
  let engineApplyError = $state('');

  // Local engine settings (track pending changes before apply)
  let pendingEngine = $state<Record<string, unknown>>({});

  // Derive current values (server value overridden by pending)
  function getSettingValue<T>(key: string): T | undefined {
    if (key in pendingEngine) return pendingEngine[key] as T;
    const setting = serverSettings?.[key];
    return setting?.value as T | undefined;
  }

  let selectedEngine = $derived(getSettingValue<string>('engine') ?? 'nemotron');

  // Whether the current engine supports hotwords (Whisper: yes, Nemotron: no)
  let hotwordsSupported = $derived(engineStatus?.info?.supports_hotwords ?? true);

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
    try {
      const serverData = await window.murmurMain.getServerSettings();
      serverSettings = serverData.settings;
      engineStatus = serverData.engine_status;
      availableEngines = serverData.available_engines ?? [];
      serverConnected = true;
    } catch {
      serverConnected = false;
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
      pendingEngine = {};

      // Poll when a reload has started (or is already visible as pending/loading).
      if (
        response.reload_started ||
        response.engine_status.status === 'loading' ||
        response.engine_status.pending
      ) {
        pollEngineStatus();
      }
    } catch (error) {
      // Keep pending changes on failure so user can retry
      engineApplyError = error instanceof Error ? error.message : 'Failed to apply engine settings.';
    } finally {
      engineApplying = false;
    }
  }

  async function pollEngineStatus() {
    const maxAttempts = 60; // 30 seconds at 500ms interval
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const status = await window.murmurMain.getEngineStatus();
        engineStatus = status;
        if (status.status === 'ready' && !status.pending) {
          // Refresh full settings to get updated values
          const data = await window.murmurMain.getServerSettings();
          serverSettings = data.settings;
          engineStatus = data.engine_status;
          availableEngines = data.available_engines ?? availableEngines;
          return;
        }
        if (status.status === 'error') {
          engineApplyError = status.message ?? 'Engine reload failed.';
          const data = await window.murmurMain.getServerSettings();
          serverSettings = data.settings;
          engineStatus = data.engine_status;
          availableEngines = data.available_engines ?? availableEngines;
          return;
        }
      } catch {
        engineApplyError = 'Failed while checking engine status.';
        return;
      }
    }

    engineApplyError = 'Timed out waiting for engine reload to finish.';
  }
</script>

<div class="h-full p-6 pr-2">
  <div class="h-full overflow-y-auto pr-4">
    {#if settingsLoaded}
    <div class="space-y-8">

    <!-- Activation -->
    <SettingsSection title="Activation">
      <SettingsRow label="Hotkey" description="Keyboard shortcut to trigger recording">
        <div class="flex items-center gap-2">
          <button
            onclick={() => openHotkeyCapture('quick')}
            class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-mono text-zinc-300 transition-colors cursor-pointer"
          >
            {hotkeyDisplayName}
          </button>
          {#if isHotkeyChanged}
            <button
              onclick={resetHotkey}
              class="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              title="Reset to Ctrl+Meta"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
              </svg>
            </button>
          {/if}
        </div>
      </SettingsRow>

      <SettingsRow label="Long Hotkey" description="Toggle hands-free long dictation">
        <div class="flex items-center gap-2">
          <button
            onclick={() => openHotkeyCapture('long')}
            class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-mono text-zinc-300 transition-colors cursor-pointer"
          >
            {longHotkeyDisplayName}
          </button>
          {#if isLongHotkeyChanged}
            <button
              onclick={resetLongHotkey}
              class="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              title="Reset to Ctrl+Shift+Meta"
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
        <div class="relative grid grid-cols-2 p-1 bg-zinc-800 rounded-lg w-[120px]">
          <!-- Sliding indicator -->
          <div
            class="absolute top-1 left-1 w-[calc(50%-4px)] h-[calc(100%-8px)] bg-zinc-700 rounded-md transition-all duration-150 ease-out
              {!settings.holdToTalk ? 'translate-x-full' : ''}"
          ></div>
          <!-- Buttons -->
          <button
            onclick={() => updateSetting('holdToTalk', true)}
            class="relative z-10 py-1 text-xs text-center rounded-md cursor-pointer transition-colors duration-150
              {settings.holdToTalk ? 'text-zinc-200' : 'text-zinc-400 hover:text-zinc-300'}"
          >
            Hold
          </button>
          <button
            onclick={() => updateSetting('holdToTalk', false)}
            class="relative z-10 py-1 text-xs text-center rounded-md cursor-pointer transition-colors duration-150
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
          value={settings.selectedDeviceId}
          onchange={(e) => updateSetting('selectedDeviceId', e.currentTarget.value)}
          disabled={isLoadingDevices}
          title={inputDevices.find(d => d.id === settings.selectedDeviceId)?.label ?? 'Default'}
          class="max-w-[280px] truncate pl-3 pr-8 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {#each inputDevices as device}
            <option value={device.id}>{device.label}</option>
          {/each}
        </select>
      </SettingsRow>

    </SettingsSection>

    <!-- Post-Processing -->
    <SettingsSection title="Post-Processing">
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
          value={settings.dictationMode}
          onchange={(e) => updateSetting('dictationMode', e.currentTarget.value as Settings['dictationMode'])}
          class="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200
            focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
        >
          <option value="raw">Raw Dictation</option>
          <option value="clean_prompt">Clean Prompt</option>
          <option value="codex_prompt">Codex Prompt</option>
          <option value="message_rewrite">Message Rewrite</option>
          <option value="command">Command Mode</option>
        </select>
      </SettingsRow>
    </SettingsSection>

    <!-- Recognition -->
    <SettingsSection title="Recognition">
      {#if !hotwordsSupported}
        <div class="flex items-start gap-3 p-4 bg-zinc-900/50 rounded-xl border border-zinc-700 w-full">
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

      <div class="w-full rounded-xl border p-4 transition-colors
        {!hotwordsSupported ? 'border-zinc-700 bg-zinc-900/50 opacity-50' : hasHotwordOverflowWarning ? 'border-amber-500/70 bg-amber-950/10' : 'border-zinc-700 bg-zinc-900/50'}">
        <label for="hotwords-csl" class="text-sm text-zinc-200 block mb-1">Custom hotwords (comma-separated)</label>
        <p class="text-xs text-zinc-500 mb-3">
          Add terms that are often transcribed incorrectly, such as product names, acronyms, and proper nouns.
          Avoid very long lists; large lists can reduce quality.
        </p>
        <textarea
          id="hotwords-csl"
          value={settings.hotwordsCsl}
          oninput={(e) => updateHotwordsCsl(e.currentTarget.value)}
          rows="4"
          disabled={!hotwordsSupported}
          class="w-full bg-zinc-800 border border-zinc-700 rounded-lg
            px-3 py-2.5 text-sm text-zinc-300
            focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600
            disabled:opacity-50 disabled:cursor-not-allowed"
          placeholder="Svelte, IPC, Claude"
        ></textarea>

        <div class="mt-3 flex items-center justify-between gap-3 flex-wrap">
          <p class="text-xs {hasHotwordOverflowWarning ? 'text-amber-300' : 'text-zinc-500'}">
            {hotwordCount} {hotwordCount === 1 ? 'term' : 'terms'}
            {#if hasHotwordOverflowWarning}
              - You have a lot of entries. Recognition quality may degrade.
            {/if}
          </p>
          <div class="flex items-center gap-2">
            <button
              onclick={importHotwords}
              disabled={!hotwordsSupported}
              class="px-3 py-1.5 bg-zinc-800 rounded-lg text-xs text-zinc-300 transition-colors
                {hotwordsSupported ? 'hover:bg-zinc-700 cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
            >
              Import
            </button>
            <button
              onclick={exportHotwords}
              disabled={!hotwordsSupported}
              class="px-3 py-1.5 bg-zinc-800 rounded-lg text-xs text-zinc-300 transition-colors
                {hotwordsSupported ? 'hover:bg-zinc-700 cursor-pointer' : 'opacity-50 cursor-not-allowed'}"
            >
              Export
            </button>
          </div>
        </div>

        {#if hotwordsFileMessage}
          <p class="mt-2 text-xs text-zinc-500">{hotwordsFileMessage}</p>
        {/if}
      </div>
    </SettingsSection>

    <!-- Behavior -->
    <SettingsSection title="Behavior">
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
          value={settings.pasteMethod}
          onchange={(e) => updateSetting('pasteMethod', e.currentTarget.value as Settings['pasteMethod'])}
          class="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200
            focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
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

    <!-- Engine -->
    <SettingsSection title="Engine">
      {#if !serverConnected}
        <div class="p-4 bg-zinc-900/50 rounded-xl w-full">
          <p class="text-xs text-zinc-500 text-center">
            Server not connected. Start the server to configure engine settings.
          </p>
        </div>
      {:else if serverSettings}
        <!-- Engine selection (radio group) -->
        <div class="w-full rounded-xl border border-zinc-700 bg-zinc-900/50 p-4">
          <p class="text-sm text-zinc-200 mb-3">Transcription Engine</p>
          <div class="space-y-2">
            {#each getOptions('engine') as option}
              <label class="flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors
                {!isEngineAvailable(option.value)
                  ? 'opacity-50 cursor-not-allowed bg-zinc-800/30'
                  : selectedEngine === option.value
                    ? 'bg-zinc-800'
                    : 'hover:bg-zinc-800/50'}">
                <input
                  type="radio"
                  name="engine"
                  value={option.value}
                  checked={selectedEngine === option.value}
                  disabled={!isEngineAvailable(option.value)}
                  onchange={() => isEngineAvailable(option.value) && updateEngineSetting('engine', option.value)}
                  class="mt-0.5 accent-emerald-500
                    {isEngineAvailable(option.value) ? 'cursor-pointer' : 'cursor-not-allowed'}"
                />
                <div>
                  <p class="text-sm text-zinc-200">{option.label}</p>
                  {#if option.description}
                    <p class="text-xs text-zinc-500 mt-0.5">{option.description}</p>
                  {/if}
                  {#if !isEngineAvailable(option.value)}
                    <p class="text-xs text-amber-300 mt-0.5">Not available in the currently running server environment.</p>
                  {/if}
                </div>
              </label>
            {/each}
          </div>
          {#if getOptions('engine').some((option) => !isEngineAvailable(option.value))}
            <p class="text-xs text-zinc-500 mt-3">
              Install missing engine dependencies and restart the server to enable those options.
            </p>
          {/if}
        </div>

        <!-- Conditional settings based on selected engine -->
        {#if serverSettings.whisper_model && isVisible(serverSettings.whisper_model)}
          <SettingsRow label={serverSettings.whisper_model.label} description={serverSettings.whisper_model.description}>
            <select
              value={getSettingValue('whisper_model') ?? serverSettings.whisper_model.value}
              onchange={(e) => updateEngineSetting('whisper_model', e.currentTarget.value)}
              class="pl-3 pr-8 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600"
            >
              {#each getOptions('whisper_model') as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </SettingsRow>
        {/if}

        {#if serverSettings.whisper_compute_type && isVisible(serverSettings.whisper_compute_type)}
          <SettingsRow label={serverSettings.whisper_compute_type.label} description={serverSettings.whisper_compute_type.description}>
            <select
              value={getSettingValue('whisper_compute_type') ?? serverSettings.whisper_compute_type.value}
              onchange={(e) => updateEngineSetting('whisper_compute_type', e.currentTarget.value)}
              class="pl-3 pr-8 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600"
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
            onclick={() => engineAdvancedOpen = !engineAdvancedOpen}
            class="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer py-1"
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
            <div class="mt-2 space-y-2">
              <!-- Device setting (show whichever is visible) -->
              {#if serverSettings.nemotron_device && isVisible(serverSettings.nemotron_device)}
                <SettingsRow label="Device" description="Hardware device for inference">
                  <select
                    value={getSettingValue('nemotron_device') ?? serverSettings.nemotron_device.value}
                    onchange={(e) => updateEngineSetting('nemotron_device', e.currentTarget.value)}
                    class="pl-3 pr-8 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600"
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
                    value={getSettingValue('whisper_device') ?? serverSettings.whisper_device.value}
                    onchange={(e) => updateEngineSetting('whisper_device', e.currentTarget.value)}
                    class="pl-3 pr-8 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600"
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

        <!-- Apply & Reload button (shown when pending changes exist) -->
        {#if hasPendingReloadChanges() || Object.keys(pendingEngine).length > 0}
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
                Apply & Reload Engine
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

    <SettingsSection title="About">
      <SettingsRow label="Version" description="Installed Eve build version">
        <button
          type="button"
          onclick={copyVersionToClipboard}
          title="Click to copy version"
          class="rounded-lg bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer"
        >
          v{appVersion}
        </button>
      </SettingsRow>
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
