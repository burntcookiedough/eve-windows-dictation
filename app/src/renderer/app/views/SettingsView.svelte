<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import HotkeyCaptureModal from '../components/HotkeyCaptureModal.svelte';
  import type { Settings, Hotkey, EngineStatus, ServerSetting } from '$shared/types';
  import { HOTWORDS_WARNING_THRESHOLD, formatHotwordsCsl, parseHotwordsCsl } from '$shared/hotwords';

  // Local settings state - loaded from main process on mount
  let settings = $state<Settings>({
    hotkey: {
      keycode: 100,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    },
    holdToTalk: true,
    autoCopy: true,
    autoPaste: true,
    silenceTimeout: 15,
    serverUrl: 'ws://localhost:51717/transcribe',
    appendPeriod: false,
    appendSpace: false,
    selectedDeviceId: 'default',
    launchOnBoot: false,
    startMinimized: false,
    serverAutoStart: true,
    hotwordsEnabled: false,
    hotwordsCsl: '',
  });

  // Default hotkey (F17)
  const DEFAULT_HOTKEY: Hotkey = {
    keycode: 100,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  };

  // Hotkey display name (human-readable)
  let hotkeyDisplayName = $state('F17');
  let isHotkeyModalOpen = $state(false);

  // Check if hotkey differs from default
  let isHotkeyChanged = $derived(
    settings.hotkey.keycode !== DEFAULT_HOTKEY.keycode ||
    settings.hotkey.ctrlKey !== DEFAULT_HOTKEY.ctrlKey ||
    settings.hotkey.altKey !== DEFAULT_HOTKEY.altKey ||
    settings.hotkey.shiftKey !== DEFAULT_HOTKEY.shiftKey ||
    settings.hotkey.metaKey !== DEFAULT_HOTKEY.metaKey
  );

  // Input devices from system enumeration
  let inputDevices = $state<Array<{ id: string; label: string }>>([
    { id: 'default', label: 'Default' },
  ]);
  let isLoadingDevices = $state(true);
  let settingsLoaded = $state(false);
  const isDevBuild = import.meta.env.DEV;
  let appVersion = $state('unknown');
  let hotwordsFileMessage = $state('');

  let hotwordEntries = $derived(parseHotwordsCsl(settings.hotwordsCsl));
  let hotwordCount = $derived(hotwordEntries.length);
  let hasHotwordOverflowWarning = $derived(hotwordCount > HOTWORDS_WARNING_THRESHOLD);

  // Server/engine settings state
  let serverSettings = $state<Record<string, ServerSetting<unknown>> | null>(null);
  let engineStatus = $state<EngineStatus | null>(null);
  let serverConnected = $state(false);
  let engineAdvancedOpen = $state(false);
  let engineApplying = $state(false);

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

  onMount(async () => {
    appVersion = await window.murmurMain.getAppVersion();

    // Load settings from main process
    const loadedSettings = await window.murmurMain.getSettings();
    settings = loadedSettings;

    // Get display name for current hotkey (use loadedSettings directly, not the $state)
    hotkeyDisplayName = await window.murmurMain.getHotkeyDisplayName(loadedSettings.hotkey);

    // Fetch server settings (engine, model, etc.)
    try {
      const serverData = await window.murmurMain.getServerSettings();
      serverSettings = serverData.settings;
      engineStatus = serverData.engine_status;
      serverConnected = true;
    } catch {
      serverConnected = false;
    }

    // Enumerate audio input devices
    try {
      // Request permission first (required to get device labels)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Release the microphone immediately after getting permission
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
    } catch (err) {
      console.error('Failed to enumerate audio devices:', err);
    } finally {
      isLoadingDevices = false;
      settingsLoaded = true;
    }
  });

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    settings[key] = value;
    window.murmurMain.updateSetting(key, value);
  }

  function updateHotwordsCsl(value: string) {
    settings.hotwordsCsl = value;
    window.murmurMain.updateSetting('hotwordsCsl', value);
    hotwordsFileMessage = '';
  }

  function openHotkeyCapture() {
    isHotkeyModalOpen = true;
  }

  function handleHotkeyCapture(hotkey: Hotkey, displayName: string) {
    isHotkeyModalOpen = false;
    settings.hotkey = hotkey;
    hotkeyDisplayName = displayName;
    window.murmurMain.updateSetting('hotkey', hotkey);
  }

  function handleHotkeyCancel() {
    isHotkeyModalOpen = false;
  }

  async function resetHotkey() {
    settings.hotkey = { ...DEFAULT_HOTKEY };
    hotkeyDisplayName = await window.murmurMain.getHotkeyDisplayName(DEFAULT_HOTKEY);
    window.murmurMain.updateSetting('hotkey', DEFAULT_HOTKEY);
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

  function updateEngineSetting(key: string, value: unknown) {
    pendingEngine = { ...pendingEngine, [key]: value };
  }

  async function applyEngineSettings() {
    if (engineApplying || Object.keys(pendingEngine).length === 0) return;
    engineApplying = true;

    try {
      const response = await window.murmurMain.updateServerSettings(pendingEngine);
      serverSettings = response.settings;
      engineStatus = response.engine_status;
      pendingEngine = {};

      // Poll engine status if loading
      if (response.engine_status.status === 'loading' || response.engine_status.pending) {
        pollEngineStatus();
      }
    } catch {
      // Keep pending changes on failure so user can retry
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
          return;
        }
        if (status.status === 'error') return;
      } catch {
        return;
      }
    }
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
            onclick={openHotkeyCapture}
            class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-mono text-zinc-300 transition-colors cursor-pointer"
          >
            {hotkeyDisplayName}
          </button>
          {#if isHotkeyChanged}
            <button
              onclick={resetHotkey}
              class="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              title="Reset to F17"
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
      <SettingsRow label="Input Device" description="Select microphone for recording">
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

      <div class="p-4 bg-zinc-900/50 rounded-xl border border-dashed border-zinc-700">
        <p class="text-xs text-zinc-500 text-center">
          More post-processing options coming soon
        </p>
      </div>
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

      <SettingsRow label="Launch on boot" description="Start application when system starts">
        <Toggle
          enabled={settings.launchOnBoot}
          onchange={(v) => updateSetting('launchOnBoot', v)}
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
                {selectedEngine === option.value ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}">
                <input
                  type="radio"
                  name="engine"
                  value={option.value}
                  checked={selectedEngine === option.value}
                  onchange={() => updateEngineSetting('engine', option.value)}
                  class="mt-0.5 cursor-pointer accent-emerald-500"
                />
                <div>
                  <p class="text-sm text-zinc-200">{option.label}</p>
                  {#if option.description}
                    <p class="text-xs text-zinc-500 mt-0.5">{option.description}</p>
                  {/if}
                </div>
              </label>
            {/each}
          </div>
        </div>

        <!-- Conditional settings based on selected engine -->
        {#if serverSettings.nemotron_chunk_ms && isVisible(serverSettings.nemotron_chunk_ms)}
          <SettingsRow label={serverSettings.nemotron_chunk_ms.label} description={serverSettings.nemotron_chunk_ms.description}>
            <select
              value={getSettingValue('nemotron_chunk_ms') ?? serverSettings.nemotron_chunk_ms.value}
              onchange={(e) => updateEngineSetting('nemotron_chunk_ms', Number(e.currentTarget.value))}
              class="pl-3 pr-8 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600"
            >
              {#each getOptions('nemotron_chunk_ms') as option}
                <option value={option.value}>
                  {option.label}{option.description ? ` - ${option.description}` : ''}
                </option>
              {/each}
            </select>
          </SettingsRow>
        {/if}

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
              <span class="text-xs text-zinc-500">~{engineStatus.info.model_size_gb} GB</span>
            {/if}
          </div>
        {/if}
      {/if}
    </SettingsSection>

    <SettingsSection title="About">
      <SettingsRow label="Version" description="Installed Murmur build version">
        <span class="rounded-lg bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300">
          v{appVersion}
        </span>
      </SettingsRow>
    </SettingsSection>

    {#if isDevBuild}
      <!-- Server -->
      <SettingsSection title="Server">
        <div class="p-4 bg-zinc-900/50 rounded-xl w-full">
          <label for="server-url" class="text-sm text-zinc-200 block mb-1">
            Server URL
          </label>
          <p class="text-xs text-zinc-500 mb-3">
            URL of the Whisper transcription server
          </p>
          <input
            id="server-url"
            type="text"
            value={settings.serverUrl}
            oninput={(e) => updateSetting('serverUrl', e.currentTarget.value)}
            class="w-full bg-zinc-800 border border-zinc-700 rounded-lg
              px-3 py-2.5 text-sm text-zinc-300 font-mono
              focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
            placeholder="ws://localhost:51717/transcribe"
          />
        </div>
      </SettingsSection>
    {/if}

    </div>
    {/if}
  </div>
</div>

<HotkeyCaptureModal
  isOpen={isHotkeyModalOpen}
  onCapture={handleHotkeyCapture}
  onCancel={handleHotkeyCancel}
/>
