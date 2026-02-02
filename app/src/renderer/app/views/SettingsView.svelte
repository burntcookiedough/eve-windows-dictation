<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import HotkeyCaptureModal from '../components/HotkeyCaptureModal.svelte';
  import type { Settings, Hotkey } from '$shared/types';

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
    silenceTimeout: 3,
    serverUrl: 'ws://localhost:51717/transcribe',
    theme: 'dark',
    appendPeriod: false,
    appendSpace: false,
    selectedDeviceId: 'default',
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

  onMount(async () => {
    // Load settings from main process
    const loadedSettings = await window.murmurMain.getSettings();
    settings = loadedSettings;

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
    }
  });

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    settings[key] = value;
    window.murmurMain.updateSetting(key, value);
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
</script>

<div class="h-full p-6 pr-2">
  <div class="h-full overflow-y-auto pr-4">
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

      <SettingsRow label="Silence Timeout" description="Seconds of silence before auto-stopping (toggle mode only)">
        <select
          value={settings.silenceTimeout}
          onchange={(e) => updateSetting('silenceTimeout', parseFloat(e.currentTarget.value))}
          disabled={settings.holdToTalk}
          class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value={1}>1.0s</option>
          <option value={1.5}>1.5s</option>
          <option value={2}>2.0s</option>
          <option value={3}>3.0s</option>
          <option value={5}>5.0s</option>
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

      <SettingsRow label="Launch on boot" description="Start application when system starts" notImplemented>
        <!-- TODO: Implement launch on boot functionality -->
        <Toggle
          enabled={false}
          onchange={(v) => console.log('Launch on boot:', v)}
          label="Launch on boot"
        />
      </SettingsRow>

      <SettingsRow label="Start minimized" description="Hide main window on application launch" notImplemented>
        <!-- TODO: Implement start minimized functionality -->
        <Toggle
          enabled={false}
          onchange={(v) => console.log('Start minimized:', v)}
          label="Start minimized"
        />
      </SettingsRow>
    </SettingsSection>

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

    </div>
  </div>
</div>

<HotkeyCaptureModal
  isOpen={isHotkeyModalOpen}
  onCapture={handleHotkeyCapture}
  onCancel={handleHotkeyCancel}
/>
