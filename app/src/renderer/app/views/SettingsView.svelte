<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import HotkeyCaptureModal from '../components/HotkeyCaptureModal.svelte';
  import type { Settings, Hotkey } from '$shared/types';
  import { HOTWORDS_WARNING_THRESHOLD, formatHotwordsCsl, parseHotwordsCsl } from '$shared/hotwords';

  const DEFAULT_SERVER_HOST = 'localhost';
  const DEFAULT_SERVER_PORT = 51717;
  const TRANSCRIBE_PATH = '/transcribe';

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
    useExternalServer: false,
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
  let appVersion = $state('unknown');
  let hotwordsFileMessage = $state('');
  let externalServerHost = $state(DEFAULT_SERVER_HOST);
  let externalServerPort = $state(String(DEFAULT_SERVER_PORT));
  let externalServerError = $state('');
  let externalServerCard: HTMLDivElement | null = $state(null);

  let hotwordEntries = $derived(parseHotwordsCsl(settings.hotwordsCsl));
  let hotwordCount = $derived(hotwordEntries.length);
  let hasHotwordOverflowWarning = $derived(hotwordCount > HOTWORDS_WARNING_THRESHOLD);

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

  onMount(async () => {
    appVersion = await window.murmurMain.getAppVersion();

    // Load settings from main process
    const loadedSettings = await window.murmurMain.getSettings();
    settings = loadedSettings;
    syncExternalServerFields(loadedSettings.serverUrl);

    // Get display name for current hotkey (use loadedSettings directly, not the $state)
    hotkeyDisplayName = await window.murmurMain.getHotkeyDisplayName(loadedSettings.hotkey);

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
        externalServerCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    }
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
      <SettingsRow label="Enable hotwords" description="Bias transcription toward your custom terms">
        <Toggle
          enabled={settings.hotwordsEnabled}
          onchange={(v) => updateSetting('hotwordsEnabled', v)}
          label="Enable hotwords"
        />
      </SettingsRow>

      <div class="w-full rounded-xl border p-4 transition-colors
        {hasHotwordOverflowWarning ? 'border-amber-500/70 bg-amber-950/10' : 'border-zinc-700 bg-zinc-900/50'}">
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
          class="w-full bg-zinc-800 border border-zinc-700 rounded-lg
            px-3 py-2.5 text-sm text-zinc-300
            focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
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
              class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 transition-colors cursor-pointer"
            >
              Import
            </button>
            <button
              onclick={exportHotwords}
              class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 transition-colors cursor-pointer"
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

    <SettingsSection title="About">
      <SettingsRow label="Version" description="Installed Murmur build version">
        <span class="rounded-lg bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300">
          v{appVersion}
        </span>
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
              Set the host and port for your transcription server. Murmur connects to <span class="font-mono">/transcribe</span>.
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
    {/if}
  </div>
</div>

<HotkeyCaptureModal
  isOpen={isHotkeyModalOpen}
  onCapture={handleHotkeyCapture}
  onCancel={handleHotkeyCancel}
/>
