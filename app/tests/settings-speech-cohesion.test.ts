import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const settings = source('../src/renderer/app/views/SettingsView.svelte');
const chooser = source('../src/renderer/app/components/SpeechModelChooser.svelte');
const modelSheet = source('../src/renderer/app/components/SpeechModelSelectionSheet.svelte');
const group = source('../src/renderer/app/components/SettingsGroup.svelte');
const skeleton = source('../src/renderer/app/components/SettingsSkeleton.svelte');

describe('Settings engine and speech controls', () => {
  test('shows the four approved groups with the model and server in Engine', () => {
    for (const name of ['Dictation', 'Output', 'Engine', 'App']) {
      expect(settings).toContain(`<SettingsSection title="${name}"`);
    }
    expect(settings).toContain('label="Speech model"');
    expect(settings).toContain('label="Server"');
    expect(settings).toContain('class="settings-server-inline"');
    expect(settings).toContain('onclick={restartServer}');
    expect(settings).toContain('settings-page-header');
    expect(settings).toContain('<SettingsSkeleton />');
    expect(skeleton).toContain('role="status"');
    expect(skeleton).not.toContain('rounded-xl');
  });

  test('keeps the curated model chooser accessible and uses only neutral visual states', () => {
    expect(chooser).toContain('data-speech-model-panel');
    expect(chooser).toContain('<fieldset class="m-0 min-w-0 border-0 p-0">');
    expect(chooser).toContain('data-speech-model-list role="radiogroup"');
    expect(chooser).toContain('type="radio"');
    expect(chooser).toContain('data-speech-model-option');
    expect(chooser).toContain('aria-label={`${preset.label}, ${label}`}');
    expect(chooser).toContain('class="model-choice-control"');
    expect(chooser).toContain('appearance: none;');
    expect(chooser).toContain('color: var(--fg2');
    expect(chooser).toContain("return 'model-state';");
    expect(chooser).toContain('class={stateClass(label)}');
    expect(chooser).not.toMatch(/(?:text|accent)-(?:emerald|sky|amber|red)-/);
    expect(chooser).not.toContain('rounded-xl');
    expect(chooser).not.toContain('Apply and prepare model confirms');
  });

  test('distinguishes current, selected, preparing, and failed states from actual engine data', () => {
    expect(chooser).toContain("if (isError(preset)) return isSelected(preset) ? 'Selected · Error' : 'Error'");
    expect(chooser).toContain("if (isCurrent(preset)) return 'Current'");
    expect(chooser).toContain("if (isSelected(preset)) return isPreparing(preset) ? 'Selected · Preparing' : 'Selected'");
    expect(chooser).toContain("if (isPreparing(preset)) return 'Preparing'");
    expect(chooser).toContain("return 'Available'");
    expect(chooser).toContain('presetMatchesCurrentEngine');
    expect(chooser).toContain('presetMatchesPreparationTarget');
    expect(chooser).toContain('presetIsPreparing');
    expect(settings).toContain('{preparationFailed}');
    expect(settings).toContain('modelDownload={sharedServerState?.modelDownload}');
  });

  test('stages model choices and retains explicit apply, retry, and revert behavior', () => {
    expect(settings).toContain('function selectPreset(preset: SpeechModelPreset)');
    expect(settings).toContain('pendingEngine = { ...pendingEngine, ...presetPatch(preset) }');
    expect(settings).toContain('function applyEngineSettings()');
    expect(settings).toContain('function revertEngineSettings()');
    expect(settings).toContain('void applyEngineSettings();');
    expect(modelSheet).toContain('onUse(draftPreset);');
    expect(modelSheet).toContain("? 'retry preparation' : 'use model'");
    expect(modelSheet).toContain("applying || preparationActive ? 'preparing…'");
    expect(modelSheet).toContain('disabled={!canUseDraft}');
    expect(modelSheet).toContain('data-model-sheet-actions');
    expect(modelSheet).toContain('onclick={revert}');
    expect(modelSheet).toContain('The current engine stays active until the selected model is ready.');
    expect(settings).toContain('enginePreparationPhase(sharedEngineStatus)');
    expect(settings).toContain('presetMatchesReadyEngine');
    expect(settings).not.toContain('async function pollEngineStatus');
  });

  test('keeps raw compatibility controls and attention-aware Advanced disclosure', () => {
    expect(settings).toContain('title="Advanced"');
    expect(settings).toContain('summary={advancedSettingsSummary}');
    expect(settings).toContain('open={advancedSettingsNeedAttention}');
    expect(settings).toContain('id="compatibility-controls"');
    expect(settings).toContain("'whisper_model'");
    expect(settings).toContain("'whisper_device'");
    expect(settings).toContain("'whisper_compute_type'");
    expect(settings).toContain("'whisper_language'");
    expect(settings).toContain('label="Paste method"');
    expect(settings).toContain('label="Auto-start server"');
    expect(settings).not.toContain("'nemotron_device'");
    expect(settings).not.toContain("'unload_before_swap'");
    expect(group).toContain('<details data-settings-group');
    expect(group).toContain('grid-template-rows: 0fr;');
    expect(group).toContain('grid-template-rows: 1fr;');
    expect(group).toContain('prefers-reduced-motion: reduce');
  });
});
