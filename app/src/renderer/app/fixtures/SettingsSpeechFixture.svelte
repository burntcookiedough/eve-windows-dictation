<script lang="ts">
  import type { EngineStatus, ModelDownloadState } from '$shared/types';
  import { SPEECH_MODEL_PRESETS, type SpeechModelPreset } from '../speech-model-presets';
  import SettingsGroup from '../components/SettingsGroup.svelte';
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import SpeechModelChooser from '../components/SpeechModelChooser.svelte';
  import Toggle from '../components/Toggle.svelte';
  import EveDropdown from '../components/EveDropdown.svelte';

  type FixtureState = 'ready' | 'preparing' | 'error' | 'external';

  const params = new URLSearchParams(globalThis.location.search);
  const fixtureState = (params.get('state') ?? 'ready') as FixtureState;
  const fixtureView = params.get('view') ?? 'all';
  let compatibilityOpen = $state(params.get('compatibility') === 'expanded');
  let selectedPreset = $state<SpeechModelPreset>(
    fixtureState === 'ready' || fixtureState === 'external'
      ? SPEECH_MODEL_PRESETS[0]!
      : SPEECH_MODEL_PRESETS[1]!,
  );

  const currentPreset = SPEECH_MODEL_PRESETS[0]!;
  const targetPreset = SPEECH_MODEL_PRESETS[1]!;
  const currentEngineStatus: EngineStatus = {
    current: currentPreset.engine,
    status: 'ready',
    info: {
      id: currentPreset.engine,
      name: 'Faster-Whisper',
      model: currentPreset.model,
      supports_hotwords: true,
      languages: ['en', 'fr', 'de'],
      model_size_gb: currentPreset.sizeGb,
      gpu_name: 'Fixture GPU',
      gpu_vram_gb: 16,
    },
  };

  const engineStatus: EngineStatus = fixtureState === 'preparing'
    ? { ...currentEngineStatus, pending: { engine: targetPreset.engine, status: 'loading', message: 'Loading selected model' } }
    : fixtureState === 'error'
      ? { ...currentEngineStatus, pending: { engine: targetPreset.engine, status: 'error', message: 'Selected model could not be prepared' } }
      : currentEngineStatus;

  const modelDownload: ModelDownloadState = fixtureState === 'preparing'
    ? {
        model: targetPreset.model,
        size_gb: targetPreset.sizeGb,
        status: 'downloading',
        phase: 'downloading',
        progress_percent: 62,
        downloaded_bytes: 1000000000,
        total_bytes: 1600000000,
        bytes_per_second: 3000000,
        eta_seconds: 120,
        current_file: 'model weights',
      }
    : fixtureState === 'error'
      ? {
          model: targetPreset.model,
          size_gb: targetPreset.sizeGb,
          status: 'error',
          phase: 'error',
          detail: 'The fixture selected-model preparation failed.',
        }
      : {
          model: currentPreset.model,
          size_gb: currentPreset.sizeGb,
          status: 'ready',
          phase: 'ready',
          cached: true,
        };

  function selectPreset(preset: SpeechModelPreset): void {
    selectedPreset = preset;
  }
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#08090a] text-zinc-100">
  <header class="flex h-12 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
    <h1 class="text-sm font-semibold text-zinc-100">Phase 2 Settings fixture</h1>
    <span data-fixture-state class="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400">{fixtureState}</span>
  </header>

  <main data-fixture-main class="min-h-0 min-w-0 flex-1 overflow-hidden">
    <div class="flex h-full min-h-0 min-w-0 w-full justify-center px-4 sm:px-6">
      <div data-fixture-scroll-owner class="min-h-0 min-w-0 w-full max-w-[640px] overflow-x-hidden overflow-y-auto overscroll-contain pr-2 [overflow-anchor:none] [scroll-behavior:auto]">
        <div class="space-y-7 pb-8">
          {#if fixtureView === 'general' || fixtureView === 'all'}
            <SettingsSection title="General" description="Shortcuts, audio, dictation, vocabulary, and app behavior." variant="content">
              <div data-fixture-general class="space-y-6">
                <SettingsGroup title="Shortcuts &amp; activation">
                  <SettingsRow label="Fast dictation hotkey" description="Start or stop fast dictation">
                    <button type="button" class="min-h-9 cursor-pointer rounded-lg bg-zinc-800 px-3 py-2 text-xs font-mono text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Ctrl+Win</button>
                  </SettingsRow>
                  <SettingsRow label="Activation mode" description="Hold-to-talk or toggle on/off">
                    <div class="grid min-h-9 w-full max-w-full grid-cols-2 rounded-lg bg-zinc-800 p-1 sm:w-[120px]">
                      <button type="button" aria-pressed="true" class="cursor-pointer rounded-md text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Hold</button>
                      <button type="button" aria-pressed="false" class="cursor-pointer rounded-md text-xs text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Toggle</button>
                    </div>
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title="Audio">
                  <SettingsRow label="Input device" description="Select microphone for recording">
                    <EveDropdown label="Input device" value="default" options={[{ value: 'default', label: 'Default' }]} onchange={() => undefined} />
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title="Dictation/output">
                  <SettingsRow label="Append period" description="Add a period at the end of transcriptions">
                    <Toggle enabled={false} label="Append period" />
                  </SettingsRow>
                  <SettingsRow label="Dictation mode" description="Local rule-based cleanup before copy or paste">
                    <EveDropdown label="Dictation mode" value="clean_prompt" options={[{ value: 'clean_prompt', label: 'Clean Prompt' }]} onchange={() => undefined} />
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title="Hotwords" description="Keep important names and terms recognizable.">
                  <SettingsRow label="Enable hotwords" description="Bias transcription toward your custom terms">
                    <Toggle enabled label="Enable hotwords" />
                  </SettingsRow>
                  <div data-fixture-hotwords-editor class="p-4">
                    <label for="fixture-hotwords" class="block text-sm text-zinc-200">Custom hotwords (comma-separated)</label>
                    <p id="fixture-hotwords-help" class="mt-1 text-xs leading-5 text-zinc-500">Add product names, acronyms, and proper nouns that are often transcribed incorrectly.</p>
                    <textarea id="fixture-hotwords" aria-describedby="fixture-hotwords-help" class="mt-3 min-h-24 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-sm text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100" rows="3">Eve, Murmur, Svelte, Nemotron</textarea>
                    <div class="mt-3 flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p class="min-w-0 text-xs text-amber-300">4 terms · Recognition quality may degrade with very long lists.</p>
                      <div class="flex min-w-0 flex-wrap gap-2">
                        <button type="button" class="min-h-9 cursor-pointer rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Import</button>
                        <button type="button" class="min-h-9 cursor-pointer rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Export</button>
                      </div>
                    </div>
                  </div>
                </SettingsGroup>

                <SettingsGroup title="App behavior">
                  <SettingsRow label="Auto-copy" description="Copy transcription to clipboard automatically"><Toggle enabled label="Auto-copy" /></SettingsRow>
                  <SettingsRow label="Auto-paste" description="Paste transcription into active window"><Toggle enabled label="Auto-paste" /></SettingsRow>
                  <SettingsRow label="Start minimized" description="Hide main window on application launch"><Toggle enabled={false} label="Start minimized" /></SettingsRow>
                </SettingsGroup>
              </div>
            </SettingsSection>
          {/if}

          {#if fixtureView === 'speech' || fixtureView === 'all'}
            <SettingsSection title="Speech model" variant="content">
              <SpeechModelChooser
                selected={selectedPreset}
                availableEngines={['nemotron', 'whisper']}
                availabilityKnown
                engineStatus={engineStatus}
                modelDownload={modelDownload}
                externalMode={fixtureState === 'external'}
                preparationFailed={fixtureState === 'error'}
                onSelect={selectPreset}
              >
                {#snippet children()}
                  {#if fixtureState === 'ready'}
                    <p data-fixture-preparation-status class="text-xs leading-5 text-emerald-300">Current model is ready. No preparation is pending.</p>
                  {:else if fixtureState === 'preparing'}
                    <p data-fixture-preparation-status class="text-xs leading-5 text-amber-300">Selected model is preparing; the current engine remains active until the selected model is ready.</p>
                    <div class="mt-3 flex flex-wrap items-center gap-2">
                      <button type="button" class="min-h-9 cursor-pointer rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Preparing…</button>
                      <button type="button" class="min-h-9 cursor-pointer rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Revert</button>
                    </div>
                  {:else if fixtureState === 'error'}
                    <p data-fixture-preparation-status class="text-xs leading-5 text-red-300">Preparation failed. Retry or revert your selected model.</p>
                    <div class="mt-3 flex flex-wrap items-center gap-2">
                      <button type="button" class="min-h-9 cursor-pointer rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Retry preparation</button>
                      <button type="button" class="min-h-9 cursor-pointer rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Revert</button>
                    </div>
                  {/if}
                {/snippet}
              </SpeechModelChooser>
            </SettingsSection>

            <section data-fixture-compatibility class="min-w-0 space-y-2" aria-labelledby="fixture-compatibility-heading">
              <div class="px-1">
                <h2 id="fixture-compatibility-heading" class="text-sm font-semibold text-zinc-400">Advanced</h2>
                <p class="mt-1 text-xs leading-5 text-zinc-500">Engine compatibility controls remain explicit and local to this fixture.</p>
              </div>
              <div class="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:p-5">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 class="text-sm font-medium text-zinc-100">Compatibility controls</h3>
                    <p class="mt-1 text-xs leading-5 text-zinc-500">Raw model, precision, language, device, and unload-before-swap settings.</p>
                  </div>
                  <button
                    type="button"
                    data-fixture-compatibility-toggle
                    aria-expanded={compatibilityOpen}
                    aria-controls="fixture-compatibility-controls"
                    onclick={() => compatibilityOpen = !compatibilityOpen}
                    class="min-h-9 cursor-pointer rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
                  >
                    {compatibilityOpen ? 'Hide controls' : 'Show controls'}
                  </button>
                </div>
                <div id="fixture-compatibility-controls" data-fixture-compatibility-controls hidden={!compatibilityOpen} class="mt-4 divide-y divide-white/[0.08] border-t border-white/[0.08] pt-2">
                    <SettingsRow label="Whisper model" description="Raw compatibility model"><EveDropdown label="Whisper model" value="large-v3-turbo" options={[{ value: 'large-v3-turbo', label: 'large-v3-turbo' }, { value: 'large-v3', label: 'large-v3' }]} onchange={() => undefined} /></SettingsRow>
                    <SettingsRow label="Compute type" description="Precision used by Faster-Whisper"><EveDropdown label="Compute type" value="int8" options={[{ value: 'int8', label: 'int8' }, { value: 'float16', label: 'float16' }]} onchange={() => undefined} /></SettingsRow>
                    <SettingsRow label="Language" description="Language hint for compatibility"><input aria-label="Whisper language" value="auto" class="min-h-9 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 sm:w-28" /></SettingsRow>
                    <SettingsRow label="Device" description="Hardware device for inference"><EveDropdown label="Whisper device" value="cuda" options={[{ value: 'cuda', label: 'cuda' }, { value: 'cpu', label: 'cpu' }]} onchange={() => undefined} /></SettingsRow>
                    <SettingsRow label="Unload before swap" description="Free VRAM before loading a new engine"><Toggle enabled label="Unload before swap" /></SettingsRow>
                </div>
                <div data-fixture-compatibility-footer class="mt-4 border-t border-white/[0.08] pt-4">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <p class="text-xs text-amber-300">Compatibility changes require an engine reload.</p>
                    <button type="button" class="min-h-9 cursor-pointer rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100">Apply compatibility changes</button>
                  </div>
                  <p class="mt-2 text-xs text-zinc-500">Engine status: Ready · Faster-Whisper · 16 GB fixture GPU</p>
                </div>
              </div>
            </section>
          {/if}
        </div>
      </div>
    </div>
  </main>
</div>
