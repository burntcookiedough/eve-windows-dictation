<script lang="ts">
  import ModelProgressCard from '../components/ModelProgressCard.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import Toggle from '../components/Toggle.svelte';

  const modelDownload = {
    model: 'large-v3-turbo',
    size_gb: 1.5,
    status: 'downloading' as const,
    phase: 'downloading' as const,
    progress_percent: 62,
    downloaded_bytes: 1000000000,
    total_bytes: 1600000000,
    bytes_per_second: 3000000,
    eta_seconds: 120,
    current_file: 'model weights',
  };
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#08090a] text-zinc-100">
  <header class="flex h-12 shrink-0 items-center justify-center px-4">
    <h1 class="text-sm font-semibold text-zinc-100">Settings fixture</h1>
  </header>

  <section
    data-status-region="model-progress"
    aria-label="Speech model status"
    class="w-full shrink-0 px-4 pb-3"
  >
    <ModelProgressCard state={modelDownload} />
  </section>

  <main data-layout-main class="min-h-0 min-w-0 flex-1 overflow-hidden">
    <div class="flex h-full min-h-0 min-w-0 w-full justify-center px-4">
      <div data-layout-scroll-owner class="min-h-0 min-w-0 w-full max-w-[640px] overflow-y-auto overscroll-contain pr-2">
        <div class="space-y-7 pb-6">
          <h2 class="sr-only">Settings</h2>

          <SettingsSection title="Shortcuts &amp; activation">
            <SettingsRow label="Fast dictation hotkey" description="Start or stop fast dictation">
              <button
                type="button"
                class="max-w-full rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-mono text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
              >
                Ctrl+Win
              </button>
            </SettingsRow>
            <SettingsRow label="Activation mode" description="Hold-to-talk or toggle on/off">
              <Toggle enabled label="Activation mode" />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Dictation/output">
            <SettingsRow label="Dictation mode" description="Local rule-based cleanup before copy or paste">
              <select aria-label="Dictation mode" class="w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 sm:w-auto">
                <option>Clean Prompt</option>
              </select>
            </SettingsRow>
            <SettingsRow label="Append space" description="Add a trailing space after transcriptions">
              <Toggle enabled={false} label="Append space" />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Hotwords" variant="panel">
            <label for="fixture-hotwords" class="block text-sm text-zinc-200">Custom hotwords</label>
            <p id="fixture-hotwords-help" class="mt-1 text-xs text-zinc-500">Add terms that are often transcribed incorrectly.</p>
            <textarea id="fixture-hotwords" aria-describedby="fixture-hotwords-help" class="mt-3 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-sm text-zinc-300" rows="4"></textarea>
          </SettingsSection>

          <SettingsSection title="App behavior">
            {#each ['Auto-copy', 'Auto-paste', 'Start minimized', 'Restore clipboard', 'Launch on boot'] as label}
              <SettingsRow {label} description="Keep this setting aligned at every zoom">
                <Toggle enabled label={label} />
              </SettingsRow>
            {/each}
          </SettingsSection>
        </div>
      </div>
    </div>
  </main>
</div>
