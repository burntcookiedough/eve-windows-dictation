<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import type { Settings } from '$shared/types';

  // Local settings state - loaded from main process on mount
  let settings = $state<Settings>({
    hotkey: 'F17',
    holdToTalk: true,
    autoCopy: true,
    autoPaste: true,
    silenceTimeout: 3,
    serverUrl: 'ws://localhost:51717/transcribe',
    theme: 'dark',
    appendPeriod: false,
    appendSpace: false,
  });

  // TODO: Input devices from system enumeration
  let inputDevices = $state([
    { id: 'default', label: 'Default' },
  ]);
  let selectedDeviceId = $state('default');

  onMount(async () => {
    // Load settings from main process
    const loadedSettings = await window.murmurMain.getSettings();
    settings = loadedSettings;
  });

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    settings[key] = value;
    // TODO: Persist to main process via IPC
    console.log('Setting changed:', key, value);
  }
</script>

<div class="h-full p-6 pr-2">
  <div class="h-full overflow-y-auto pr-4">
    <div class="space-y-8">

    <!-- Activation -->
    <SettingsSection title="Activation">
      <SettingsRow label="Hotkey" description="Keyboard shortcut to trigger recording" notImplemented>
        <!-- TODO: Implement hotkey capture dialog -->
        <button class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-mono text-zinc-300 transition-colors cursor-pointer">
          {settings.hotkey}
        </button>
      </SettingsRow>

      <SettingsRow label="Activation Mode" description="Hold-to-talk or toggle on/off" notImplemented>
        <div class="flex gap-1 p-1 bg-zinc-800 rounded-lg">
          <button
            onclick={() => updateSetting('holdToTalk', true)}
            class="px-3 py-1 text-xs rounded-md transition-colors cursor-pointer
              {settings.holdToTalk ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-400 hover:text-zinc-300'}"
          >
            Hold
          </button>
          <button
            onclick={() => updateSetting('holdToTalk', false)}
            class="px-3 py-1 text-xs rounded-md transition-colors cursor-pointer
              {!settings.holdToTalk ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-400 hover:text-zinc-300'}"
          >
            Toggle
          </button>
        </div>
      </SettingsRow>
    </SettingsSection>

    <!-- Audio -->
    <SettingsSection title="Audio">
      <SettingsRow label="Input Device" description="Select microphone for recording" notImplemented>
        <!-- TODO: Populate with actual system audio devices -->
        <select
          bind:value={selectedDeviceId}
          class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600"
        >
          {#each inputDevices as device}
            <option value={device.id}>{device.label}</option>
          {/each}
        </select>
      </SettingsRow>

      <SettingsRow label="Silence Timeout" description="Seconds of silence before auto-stopping" notImplemented>
        <select
          value={settings.silenceTimeout}
          onchange={(e) => updateSetting('silenceTimeout', parseFloat(e.currentTarget.value))}
          class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600"
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
      <SettingsRow label="Append period" description="Add a period at the end of transcriptions" notImplemented>
        <Toggle
          enabled={settings.appendPeriod}
          onchange={(v) => updateSetting('appendPeriod', v)}
          label="Append period"
        />
      </SettingsRow>

      <SettingsRow label="Append space" description="Add a trailing space after transcriptions" notImplemented>
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
      <SettingsRow label="Auto-copy" description="Copy transcription to clipboard automatically" notImplemented>
        <Toggle
          enabled={settings.autoCopy}
          onchange={(v) => updateSetting('autoCopy', v)}
          label="Auto-copy"
        />
      </SettingsRow>

      <SettingsRow label="Auto-paste" description="Paste transcription into active window" notImplemented>
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
      <div class="p-4 bg-zinc-900/50 rounded-xl w-full border border-red-900">
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
