<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { EngineStatus, ModelDownloadState } from '$shared/types';
  import { SPEECH_MODEL_PRESETS, presetMatchesCurrentEngine, type SpeechModelPreset } from '../speech-model-presets';

  interface Props {
    selected: SpeechModelPreset | null;
    availableEngines: string[];
    availabilityKnown: boolean;
    engineStatus: EngineStatus | null;
    modelDownload?: ModelDownloadState;
    externalMode: boolean;
    preparationFailed: boolean;
    onSelect: (preset: SpeechModelPreset) => void;
    children?: Snippet;
  }

  let {
    selected,
    availableEngines,
    availabilityKnown,
    engineStatus,
    modelDownload,
    externalMode,
    preparationFailed,
    onSelect,
    children,
  }: Props = $props();
  const componentId = $props.id();
  const helpId = `speech-model-help-${componentId}`;

  function detailId(presetId: SpeechModelPreset['id']): string {
    return `speech-model-${componentId}-${presetId}-detail`;
  }

  function unavailable(preset: SpeechModelPreset): boolean {
    return availabilityKnown && !availableEngines.includes(preset.engine);
  }

  function isCurrent(preset: SpeechModelPreset): boolean {
    return presetMatchesCurrentEngine(preset, engineStatus);
  }

  function isSelected(preset: SpeechModelPreset): boolean {
    return selected?.id === preset.id && !isCurrent(preset);
  }

  function isTargeted(preset: SpeechModelPreset): boolean {
    return modelDownload?.model === preset.model;
  }

  function isPreparing(preset: SpeechModelPreset): boolean {
    if (!isTargeted(preset)) return false;
    return modelDownload?.status === 'partial'
      || modelDownload?.status === 'downloading'
      || modelDownload?.phase === 'checking'
      || modelDownload?.phase === 'downloading'
      || modelDownload?.phase === 'loading'
      || engineStatus?.pending?.engine === preset.engine;
  }

  function isError(preset: SpeechModelPreset): boolean {
    return isTargeted(preset) && preparationFailed;
  }

  function stateLabel(preset: SpeechModelPreset): string {
    if (unavailable(preset)) return 'Unavailable';
    if (isError(preset)) return isSelected(preset) ? 'Selected · Error' : 'Error';
    if (isCurrent(preset)) return 'Current';
    if (isSelected(preset)) return isPreparing(preset) ? 'Selected · Preparing' : 'Selected';
    if (isPreparing(preset)) return 'Preparing';
    return 'Available';
  }

  function stateClass(label: string): string {
    switch (label) {
      case 'Current':
        return 'text-emerald-300';
      case 'Selected':
        return 'text-sky-300';
      case 'Selected · Preparing':
      case 'Preparing':
        return 'text-amber-300';
      case 'Selected · Error':
      case 'Error':
        return 'text-red-300';
      case 'Unavailable':
        return 'text-zinc-500';
      default:
        return 'text-zinc-400';
    }
  }
</script>

<div data-speech-model-panel class="min-w-0 w-full rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:p-5">
  <fieldset class="m-0 min-w-0 border-0 p-0" aria-describedby={helpId}>
    <legend class="text-sm font-medium text-zinc-100">Choose a speech model</legend>
    <p id={helpId} class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">
      Select a curated model to stage. Apply and prepare model confirms the change. The current engine stays active until the selected model is ready.
    </p>

    {#if externalMode}
      <div data-speech-model-external role="status" class="mt-4 border-t border-white/[0.08] pt-4 text-xs leading-5 text-zinc-400">
        An external server controls model preparation. Manage its model through that server's own endpoint.
      </div>
    {:else}
      <div data-speech-model-list role="radiogroup" aria-label="Curated speech models" class="mt-4 divide-y divide-white/[0.08]">
        {#each SPEECH_MODEL_PRESETS as preset}
          {@const disabled = externalMode || unavailable(preset)}
          {@const checked = selected?.id === preset.id}
          {@const label = stateLabel(preset)}
          <label
            data-speech-model-option
            class="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0 focus-within:rounded-lg focus-within:outline-none focus-within:ring-2 focus-within:ring-zinc-100 focus-within:ring-offset-2 focus-within:ring-offset-[#08090a]
              {disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}"
          >
            <input
              class="sr-only"
              type="radio"
              name={`speech-model-preset-${componentId}`}
              checked={checked}
              disabled={disabled}
              onchange={() => onSelect(preset)}
              aria-label={`${preset.label}, ${label}`}
              aria-describedby={detailId(preset.id)}
            />
            <span
              aria-hidden="true"
              class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border {checked ? 'border-sky-300' : 'border-zinc-600'}"
            >
              {#if checked}
                <span class="h-2 w-2 rounded-full bg-sky-300"></span>
              {/if}
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-3 sm:gap-y-1">
                <span class="min-w-0 text-sm font-medium text-zinc-100 [overflow-wrap:anywhere]">{preset.label}</span>
                <span data-speech-model-state class="max-w-full text-xs [overflow-wrap:anywhere] {stateClass(label)}">{label}</span>
              </span>
              <span id={detailId(preset.id)} class="mt-1 block text-xs leading-5 text-zinc-400 [overflow-wrap:anywhere]">
                {preset.language} · approx. {preset.sizeGb} GB. {preset.summary}
              </span>
              {#if disabled}
                <span class="mt-1 block text-xs text-amber-300">This server does not have the required {preset.engine} runtime.</span>
              {:else if isError(preset)}
                <span class="mt-1 block text-xs text-red-300">Preparation failed. Use Retry preparation or Revert below.</span>
              {/if}
            </span>
          </label>
        {/each}
      </div>
    {/if}
  </fieldset>

  {#if children}
    <div data-model-action-footer class="mt-4 border-t border-white/[0.08] pt-4">
      {@render children()}
    </div>
  {/if}
</div>
