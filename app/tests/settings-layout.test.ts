import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const settings = source('../src/renderer/app/views/SettingsView.svelte');
const row = source('../src/renderer/app/components/SettingsRow.svelte');
const section = source('../src/renderer/app/components/SettingsSection.svelte');
const group = source('../src/renderer/app/components/SettingsGroup.svelte');
const sheet = source('../src/renderer/app/components/SettingsBottomSheet.svelte');
const modelSheet = source('../src/renderer/app/components/SpeechModelSelectionSheet.svelte');
const dropdown = source('../src/renderer/app/components/EveDropdown.svelte');
const toggle = source('../src/renderer/app/components/Toggle.svelte');
const hotkeyModal = source('../src/renderer/app/components/HotkeyCaptureModal.svelte');
const serverView = source('../src/renderer/app/views/ServerView.svelte');

describe('Settings redesign contracts', () => {
  test('keeps the approved four-section hierarchy and compact divider rows', () => {
    expect(settings.match(/<SettingsSection title=/g)).toHaveLength(4);
    for (const sectionName of ['Dictation', 'Output', 'Engine', 'App']) {
      expect(settings).toContain(`<SettingsSection title="${sectionName}"`);
    }
    expect(settings).toContain('<PrimaryPage page="settings" scrollOwner="settings-page"');
    expect(settings).not.toContain('overflow-y-auto');
    expect(section).toContain('margin-top: 26px;');
    expect(section).toContain('font-size: 10px;');
    expect(section).toContain('letter-spacing: 0.12em;');
    expect(row).toContain('min-height: 46px;');
    expect(row).toContain('border-top: 1px solid var(--line');
    expect(settings).not.toContain('rounded-xl');
    expect(settings).not.toContain('bg-emerald-');
    expect(settings).not.toContain('text-red-');
  });

  test('retains hotkey, activation, microphone, output, and app setting actions', () => {
    for (const capability of [
      "openHotkeyCapture('quick')",
      "openHotkeyCapture('long')",
      'resetHotkey',
      'resetLongHotkey',
      "updateSetting('holdToTalk'",
      "updateSetting('selectedDeviceId'",
      "updateSetting('dictationMode'",
      "updateSetting('appendPeriod'",
      "updateSetting('appendSpace'",
      "updateSetting('autoCopy'",
      "updateSetting('autoPaste'",
      "updateSetting('restoreClipboardAfterPaste'",
      "updateSetting('startMinimized'",
      "updateSetting('appearance', 'dark')",
      "updateSetting('appearance', 'light')",
      'updateLaunchOnBoot',
      'onclick={onReplayIntro}',
    ]) expect(settings).toContain(capability);

    expect(settings).toContain('onReplayIntro?: () => void;');
    expect(settings).toContain('onReplayIntro = () => {}');
    expect(settings).toContain('function updateSetting<K extends keyof Settings>');
  });

  test('keeps vocabulary import/export and edits in a real, accessible sheet', () => {
    expect(settings).toContain("activeSheet = 'vocabulary';");
    expect(settings).toContain('function saveVocabulary()');
    expect(settings).toContain("updateSetting('hotwordsCsl'");
    expect(settings).toContain("updateSetting('hotwordsEnabled'");
    expect(settings).toContain('window.murmurMain.importHotwordsFromFile()');
    expect(settings).toContain('window.murmurMain.exportHotwordsToFile(value)');
    expect(settings).toContain('HOTWORDS_WARNING_THRESHOLD');
    expect(settings).toContain('aria-describedby="settings-vocabulary-help settings-vocabulary-count"');
    expect(settings).toContain('placeholder="One term per line"');
    expect(settings).not.toContain('placeholder="Svelte');
    expect(settings).toContain('Use vocabulary');
  });

  test('keeps the model chooser and keyboard sheet controls functional and monochrome', () => {
    expect(settings).toContain("activeSheet = 'model';");
    expect(settings).toContain('presets={speechModelPresets}');
    expect(settings).toContain('onUse={selectPreset}');
    expect(settings).toContain('async function applyEngineSettings(requestedPatch: Record<string, unknown> = pendingEngine)');
    expect(settings).toContain('onclick={() => applyEngineSettings()}');
    expect(settings).toContain('function revertEngineSettings()');
    expect(modelSheet).toContain('data-model-sheet-actions');
    expect(modelSheet).toContain('description="Runs on this machine. Nothing you say leaves it."');
    expect(modelSheet).toContain('onclick={close}>cancel</button>');
    expect(modelSheet).toContain('disabled={!canUseDraft}');
    expect(modelSheet).toContain('draftPresetId = null;');
    expect(modelSheet).toContain('onUse(draftPreset);');
    expect(sheet).toContain('role="dialog"');
    expect(sheet).toContain('aria-modal={open}');
    expect(sheet).toContain('inert={!open}');
    expect(sheet).toContain("event.key === 'Escape'");
    expect(sheet).toContain("event.key !== 'Tab'");
    expect(sheet).toContain('element.getClientRects().length > 0');
    expect(sheet).toContain("element.closest('[hidden], [inert], [aria-hidden=\"true\"]')");
    expect(sheet).toContain('focusGeneration');
    expect(dropdown).toContain('event.stopPropagation();');
    expect(dropdown).toContain("if (!open) return;");
    expect(dropdown).not.toContain('text-sky-');
    expect(dropdown).not.toContain('accent-sky-');
    expect(dropdown).toContain('data-eve-dropdown');
  });

  test('keeps launch and switch semantics with a usable hit target', () => {
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain('aria-checked={enabled}');
    expect(toggle).toContain('aria-label={label}');
    expect(toggle).toContain('width: 40px;');
    expect(toggle).toContain('height: 40px;');
    expect(toggle).toContain('width: 30px;');
    expect(toggle).toContain('height: 16px;');
    expect(toggle).toContain('@media (prefers-reduced-motion: reduce)');
    expect(hotkeyModal).toContain('class="hotkey-capture-layer"');
    expect(hotkeyModal).toContain('aria-modal="true"');
    expect(hotkeyModal).toContain('captureGeneration += 1;');
    expect(hotkeyModal).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('uses the flat Advanced disclosure and preserves server, compatibility, and GPU controls', () => {
    expect(settings).toContain('title="Advanced"');
    expect(settings).toContain('collapsible');
    expect(settings).toContain('summary={advancedSettingsSummary}');
    expect(settings).toContain('open={advancedSettingsNeedAttention}');
    expect(settings).toContain('id="compatibility-controls"');
    expect(settings).toContain("'whisper_model'");
    expect(settings).toContain("'whisper_device'");
    expect(settings).toContain("'whisper_compute_type'");
    expect(settings).toContain("'whisper_language'");
    expect(settings).toContain('label="Paste method"');
    expect(settings).toContain('label="Auto-start server"');
    expect(settings).toContain('data-gpu-pack-status');
    expect(settings).toContain('data-server-diagnostics');
    expect(settings).toContain('<ServerView embedded showAutoStart={false} />');
    expect(serverView).toContain('data-server-logs');
    expect(group).toContain('<details data-settings-group');
    expect(group).toContain('grid-template-rows: 0fr;');
    expect(group).toContain('prefers-reduced-motion: reduce');
  });
});
