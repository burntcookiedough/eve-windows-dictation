<script lang="ts">
  import type { EngineStatus, ModelDownloadState } from '$shared/types';
  import { SPEECH_MODEL_PRESETS, presetDownloadLabel, presetMatchesEngine, type SpeechModelPreset } from '../speech-model-presets';

  interface Props {
    selected: SpeechModelPreset | null;
    availableEngines: string[];
    availabilityKnown: boolean;
    engineStatus: EngineStatus | null;
    modelDownload?: ModelDownloadState;
    externalMode: boolean;
    onSelect: (preset: SpeechModelPreset) => void;
  }

  let { selected, availableEngines, availabilityKnown, engineStatus, modelDownload, externalMode, onSelect }: Props = $props();
  function unavailable(preset: SpeechModelPreset): boolean {
    return availabilityKnown && !availableEngines.includes(preset.engine);
  }
</script>

<fieldset class="space-y-3" aria-describedby="speech-model-help">
  <legend class="text-sm font-medium text-zinc-200">Choose a speech model</legend>
  <p id="speech-model-help" class="text-xs text-zinc-500">Choosing a model only stages it. Apply and prepare model confirms the change.</p>
  {#if externalMode}
    <p class="rounded-lg border border-zinc-700 p-3 text-xs text-zinc-400">An external server controls its own model preparation. Configure it through its own endpoint.</p>
  {:else}
    <div class="grid gap-2 sm:grid-cols-2">
      {#each SPEECH_MODEL_PRESETS as preset}
        {@const disabled = unavailable(preset)}
        <label class="rounded-xl border p-3 transition-colors focus-within:outline-hidden focus-within:ring-2 focus-within:ring-zinc-100 {disabled ? 'border-zinc-800 opacity-60 cursor-not-allowed' : 'border-white/10 hover:bg-white/[0.04] cursor-pointer'}">
          <input class="sr-only" type="radio" name="speech-model-preset" checked={selected?.id === preset.id} disabled={disabled} onchange={() => onSelect(preset)} aria-describedby={`preset-${preset.id}-detail`} />
          <span class="flex items-start justify-between gap-3"><span class="text-sm font-medium text-zinc-100">{preset.label}</span><span class="text-xs text-zinc-400">{presetMatchesEngine(preset, engineStatus) ? 'Current' : selected?.id === preset.id ? 'Selected' : presetDownloadLabel(modelDownload, preset)}</span></span>
          <span id={`preset-${preset.id}-detail`} class="mt-1 block text-xs leading-5 text-zinc-400">{preset.language} · approx. {preset.sizeGb} GB. {preset.summary}</span>
          {#if disabled}<span class="mt-2 block text-xs text-amber-300">This server does not have the required {preset.engine} runtime.</span>{/if}
        </label>
      {/each}
    </div>
  {/if}
</fieldset>
