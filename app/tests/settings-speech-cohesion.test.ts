import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const settingsView = source('../src/renderer/app/views/SettingsView.svelte');
const chooser = source('../src/renderer/app/components/SpeechModelChooser.svelte');
const settingsGroup = source('../src/renderer/app/components/SettingsGroup.svelte');

describe('Phase 2 General and Speech cohesion contracts', () => {
  test('keeps General flat while removing the Hotwords card-within-card collision', () => {
    expect(settingsView).toContain('<SettingsSection title="General"');
    expect(settingsView).toContain('data-settings-general');
    expect(settingsView).toContain('data-hotwords-editor');
    expect(settingsView).toContain('HOTWORDS_WARNING_THRESHOLD');
    expect(settingsView).toContain('importHotwords');
    expect(settingsView).toContain('exportHotwords');
    expect(settingsView).not.toContain('<SettingsSection title="Hotwords"');
    expect(settingsView).not.toContain('data-hotwords-editor class="mt-4 w-full min-w-0 border');
    expect(settingsGroup).toContain('rounded-xl border border-white/10 bg-white/[0.025]');
  });

  test('renders one padded single-column accessible speech model panel', () => {
    expect(chooser).toContain('data-speech-model-panel');
    expect(chooser).toContain('<fieldset class="m-0 min-w-0 border-0 p-0"');
    expect(chooser).toContain('data-speech-model-list role="radiogroup"');
    expect(chooser).toContain('type="radio"');
    expect(chooser).toContain('data-speech-model-option');
    expect(chooser).toContain('name={`speech-model-preset-${componentId}`}');
    expect(chooser).toContain('focus-within:outline');
    expect(chooser).toContain('outline-offset-[-2px]');
    expect(chooser).not.toContain('sm:grid-cols-2');
    expect(chooser).not.toContain('rounded-xl border p-3 transition-colors');
  });

  test('distinguishes current, selected, available, preparing, error, and external states', () => {
    expect(chooser).toContain("if (isError(preset)) return isSelected(preset) ? 'Selected · Error' : 'Error'");
    expect(chooser).toContain("if (isPreparing(preset)) return 'Preparing'");
    expect(chooser).toContain("if (isCurrent(preset)) return 'Current'");
    expect(chooser).toContain('if (isSelected(preset)) return isPreparing(preset)');
    expect(chooser).toContain("'Selected'");
    expect(chooser).toContain("return 'Available'");
    expect(chooser).toContain("return 'Unavailable'");
    expect(chooser).toContain('data-speech-model-external');
    expect(chooser).toContain('preparationFailed: boolean');
    expect(settingsView).toContain('preparationFailed={preparationFailed}');
  });

  test('keeps explicit prepare/retry/revert semantics and current-until-ready copy', () => {
    expect(chooser).toContain('Apply and prepare model confirms the change');
    expect(settingsView).toContain('Apply and prepare model');
    expect(settingsView).toContain("'Retry preparation'");
    expect(settingsView).toContain('>Revert</button>');
    expect(settingsView).toContain('current engine remains active until the selected model is ready');
    expect(settingsView).toContain('selectPreset');
    expect(settingsView).toContain('if (externalMode || !isEngineAvailable(preset.engine)) return;');
    expect(settingsView).not.toContain('async function pollEngineStatus');
    expect(settingsView).toContain('void loadServerSettings()');
  });

  test('puts raw compatibility controls behind one accessible disclosure and footer', () => {
    expect(settingsView).toContain('<h3 class="text-sm font-medium text-zinc-100">Compatibility controls</h3>');
    expect(settingsView).toContain('aria-expanded={compatibilityControlsOpen}');
    expect(settingsView).toContain('aria-controls="compatibility-controls"');
    expect(settingsView).toContain('id="compatibility-controls"');
    expect(settingsView).toContain('hidden={!compatibilityControlsOpen}');
    expect(settingsView).toContain('hasPendingCompatibilityChanges(pendingEngine, stagedPreset)');
    expect(chooser).toContain('externalMode || unavailable(preset)');
    expect(settingsView).toContain("'whisper_compute_type'");
    expect(settingsView).toContain("'whisper_language'");
    expect(settingsView).not.toContain("'nemotron_device'");
    expect(settingsView).toContain("'whisper_device'");
    expect(settingsView).toContain("'unload_before_swap'");
    expect(settingsView).toContain('data-compatibility-footer');
    expect(settingsView).toContain('Apply compatibility changes');
    expect(settingsView).toContain('data-engine-status');
    expect(settingsView).toContain('disabled={externalMode}');
    expect(settingsView).not.toContain('engineAdvancedOpen');
    expect(settingsView).not.toContain('engine-advanced-options');
  });
});
