<script lang="ts">
  import SettingsBottomSheet from './SettingsBottomSheet.svelte';
  import SpeechModelChooser from './SpeechModelChooser.svelte';
  import type { EngineStatus, ModelDownloadState } from '$shared/types';
  import type { SpeechModelPreset } from '../speech-model-presets';

  interface Props {
    open: boolean;
    serverAvailable: boolean;
    presets: readonly SpeechModelPreset[];
    selected: SpeechModelPreset | null;
    selectedNeedsApply: boolean;
    engineStatus: EngineStatus | null;
    modelDownload?: ModelDownloadState;
    preparationFailed: boolean;
    preparationActive: boolean;
    applying: boolean;
    canRevert: boolean;
    revertDisabled: boolean;
    errorMessage: string;
    onClose: () => void;
    onUse: (preset: SpeechModelPreset) => void;
    onRevert: () => void;
  }

  let {
    open,
    serverAvailable,
    presets,
    selected,
    selectedNeedsApply,
    engineStatus,
    modelDownload,
    preparationFailed,
    preparationActive,
    applying,
    canRevert,
    revertDisabled,
    errorMessage,
    onClose,
    onUse,
    onRevert,
  }: Props = $props();

  let draftPresetId = $state<string | null>(null);
  let wasOpen = false;
  let draftPreset = $derived(presets.find((preset) => preset.id === draftPresetId) ?? null);
  let draftNeedsApply = $derived(
    draftPreset !== null
    && (draftPreset.id !== selected?.id || (draftPreset.id === selected?.id && selectedNeedsApply))
  );
  let canUseDraft = $derived(
    draftNeedsApply && serverAvailable && !applying && !preparationActive
  );

  $effect(() => {
    if (open && !wasOpen) draftPresetId = selected?.id ?? null;
    wasOpen = open;
  });

  function selectDraft(preset: SpeechModelPreset): void {
    draftPresetId = preset.id;
  }

  function close(): void {
    draftPresetId = null;
    onClose();
  }

  function useDraft(): void {
    if (!canUseDraft || !draftPreset) return;
    onUse(draftPreset);
  }

  function revert(): void {
    if (revertDisabled) return;
    onRevert();
    close();
  }
</script>

<SettingsBottomSheet
  {open}
  title="Speech model"
  description="Runs on this machine. Nothing you say leaves it."
  onClose={close}
>
  {#if !serverAvailable}
    <p class="model-sheet-note">Speech model choices are available when the server reports its settings.</p>
    {#if errorMessage}<p role="alert" class="model-sheet-error">{errorMessage}</p>{/if}
    <div class="model-sheet-actions model-sheet-actions--unavailable">
      <button type="button" class="model-sheet-secondary" onclick={close}>cancel</button>
      <span class="model-sheet-spacer"></span>
      <button type="button" class="model-sheet-primary" disabled>use model</button>
    </div>
  {:else}
    <SpeechModelChooser
      presets={presets}
      selected={draftPreset}
      {engineStatus}
      {modelDownload}
      {preparationFailed}
      onSelect={selectDraft}
    >
      {#snippet children()}
        {#if selectedNeedsApply}
          <p data-model-preparation-status class="model-sheet-status" data-state={preparationFailed ? 'error' : 'pending'}>
            {preparationFailed ? 'Preparation failed. Retry or revert the selected model.' : 'The current engine stays active until the selected model is ready.'}
          </p>
        {/if}
        <div data-model-sheet-actions class="model-sheet-actions">
          <button type="button" class="model-sheet-secondary" onclick={close}>cancel</button>
          {#if canRevert}
            <button type="button" class="model-sheet-secondary" onclick={revert} disabled={revertDisabled}>revert</button>
          {/if}
          <span class="model-sheet-spacer"></span>
          <button type="button" class="model-sheet-primary" onclick={useDraft} disabled={!canUseDraft}>
            {applying || preparationActive ? 'preparing…' : preparationFailed ? 'retry preparation' : 'use model'}
          </button>
        </div>
        {#if errorMessage}<p role="alert" class="model-sheet-error">{errorMessage}</p>{/if}
      {/snippet}
    </SpeechModelChooser>
  {/if}
</SettingsBottomSheet>

<style>
  .model-sheet-note,
  .model-sheet-status,
  .model-sheet-error {
    margin: 0;
    color: var(--fg2, #9b9b9b);
    font-size: 11px;
    line-height: 1.5;
  }

  .model-sheet-status,
  .model-sheet-error {
    margin-top: 10px;
  }

  .model-sheet-error {
    color: var(--fg, #ececec);
  }

  .model-sheet-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .model-sheet-actions--unavailable {
    margin-top: 18px;
  }

  .model-sheet-spacer {
    flex: 1 1 auto;
  }

  .model-sheet-primary,
  .model-sheet-secondary {
    min-height: 34px;
    border: 0;
    border-radius: 0;
    padding: 4px 0;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .model-sheet-primary {
    min-width: 82px;
    border: 1px solid var(--fg, #ececec);
    padding: 7px 12px;
    background: var(--fg, #ececec);
    color: var(--bg, #0b0b0b);
    text-align: center;
  }

  .model-sheet-secondary {
    color: var(--fg3, #565656);
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 3px;
  }

  .model-sheet-secondary:hover:not(:disabled) {
    color: var(--fg, #ececec);
    text-decoration-color: currentColor;
  }

  .model-sheet-primary:disabled,
  .model-sheet-secondary:disabled {
    color: var(--fg3, #565656);
    cursor: not-allowed;
    opacity: 0.5;
  }

  .model-sheet-primary:focus-visible,
  .model-sheet-secondary:focus-visible {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  @media (prefers-reduced-motion: reduce) {
    .model-sheet-primary,
    .model-sheet-secondary {
      transition-duration: 1ms;
    }
  }
</style>
