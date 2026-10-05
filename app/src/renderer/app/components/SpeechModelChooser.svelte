<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { EngineStatus, ModelDownloadState } from '$shared/types';
  import { presetIsPreparing, presetMatchesCurrentEngine, presetMatchesPreparationTarget, type SpeechModelPreset } from '../speech-model-presets';

  interface Props {
    presets: readonly SpeechModelPreset[];
    selected: SpeechModelPreset | null;
    engineStatus: EngineStatus | null;
    modelDownload?: ModelDownloadState;
    preparationFailed: boolean;
    onSelect: (preset: SpeechModelPreset) => void;
    children?: Snippet;
  }

  let {
    presets,
    selected,
    engineStatus,
    modelDownload,
    preparationFailed,
    onSelect,
    children,
  }: Props = $props();
  const componentId = $props.id();

  function detailId(presetId: SpeechModelPreset['id']): string {
    return `speech-model-${componentId}-${presetId}-detail`;
  }

  function isCurrent(preset: SpeechModelPreset): boolean {
    return presetMatchesCurrentEngine(preset, engineStatus);
  }

  function isSelected(preset: SpeechModelPreset): boolean {
    return selected?.id === preset.id && !isCurrent(preset);
  }

  function isTargeted(preset: SpeechModelPreset): boolean {
    return presetMatchesPreparationTarget(preset, engineStatus, modelDownload);
  }

  function isPreparing(preset: SpeechModelPreset): boolean {
    return presetIsPreparing(preset, engineStatus, modelDownload);
  }

  function isError(preset: SpeechModelPreset): boolean {
    return isTargeted(preset) && preparationFailed;
  }

  function stateLabel(preset: SpeechModelPreset): string {
    if (isError(preset)) return isSelected(preset) ? 'Selected · Error' : 'Error';
    if (isCurrent(preset)) return 'Current';
    if (isSelected(preset)) return isPreparing(preset) ? 'Selected · Preparing' : 'Selected';
    if (isPreparing(preset)) return 'Preparing';
    return 'Available';
  }

  function stateClass(_label: string): string {
    return 'model-state';
  }
</script>

<div data-speech-model-panel class="model-panel min-w-0 w-full">
  <fieldset class="m-0 min-w-0 border-0 p-0">
    <legend class="model-legend">Choose a speech model</legend>

    {#if presets.length === 0}
      <p data-model-catalog-empty class="model-empty">
        Curated model metadata is unavailable from this server. Use the raw compatibility controls below to select a model.
      </p>
    {:else}
      <div data-speech-model-list role="radiogroup" aria-label="Curated speech models" class="model-list">
        {#each presets as preset}
        {@const checked = selected?.id === preset.id}
        {@const label = stateLabel(preset)}
        <label
          data-speech-model-option
          class="model-option"
        >
          <input
            class="model-choice-control"
            type="radio"
            name={`speech-model-preset-${componentId}`}
            checked={checked}
            onchange={() => onSelect(preset)}
            aria-label={`${preset.label}, ${label}`}
            aria-describedby={detailId(preset.id)}
          />
          <span class="min-w-0 flex-1">
            <span class="model-option-heading">
              <span class="model-option-name">{preset.label}</span>
              <span data-speech-model-state class={stateClass(label)}>{label}</span>
            </span>
            <span id={detailId(preset.id)} class="model-option-detail">
              {preset.language} · approx. {preset.sizeGb} GB. {preset.summary}
            </span>
            {#if isError(preset)}
              <span class="model-option-error">Preparation failed. Use Retry preparation or Revert below.</span>
            {/if}
          </span>
        </label>
        {/each}
      </div>
    {/if}
  </fieldset>

  {#if children}
    <div data-model-action-footer class="model-actions">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .model-panel,
  .model-list {
    min-width: 0;
  }

  .model-legend {
    color: var(--fg, #ececec);
    font-size: 13px;
    font-weight: 400;
  }

  .model-help,
  .model-empty,
  .model-option-detail,
  .model-option-error {
    display: block;
    margin: 6px 0 0;
    color: var(--fg2, #9b9b9b);
    font-size: 11px;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .model-list {
    margin-top: 14px;
  }

  .model-option {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    gap: 11px;
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.07));
    padding: 10px 0;
    color: var(--fg, #ececec);
    cursor: pointer;
  }

  .model-option-heading {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px 12px;
  }

  .model-option-name {
    color: var(--fg, #ececec);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .model-state {
    color: var(--fg2, #9b9b9b);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 9px;
    white-space: nowrap;
  }

  .model-option-detail {
    margin-top: 3px;
  }

  .model-choice-control {
    width: 13px;
    height: 13px;
    flex: none;
    appearance: none;
    margin: 2px 0 0;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
  }

  .model-choice-control:checked {
    border-color: var(--fg, #ececec);
    background: radial-gradient(circle, var(--fg, #ececec) 0 3px, transparent 3.5px);
  }

  .model-choice-control:focus-visible {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  .model-choice-control:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .model-option-error {
    margin-top: 3px;
    color: var(--fg, #ececec);
  }

  .model-actions {
    margin-top: 12px;
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.07));
    padding-top: 12px;
  }
</style>
