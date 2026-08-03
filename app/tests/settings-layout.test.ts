import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const appView = source('../src/renderer/app/App.svelte');
const appCss = source('../src/renderer/app/app.css');
const appHtml = source('../src/renderer/app/index.html');
const settingsView = source('../src/renderer/app/views/SettingsView.svelte');
const settingsGroup = source('../src/renderer/app/components/SettingsGroup.svelte');
const settingsSection = source('../src/renderer/app/components/SettingsSection.svelte');
const settingsRow = source('../src/renderer/app/components/SettingsRow.svelte');
const statusBanner = source('../src/renderer/app/components/ModelProgressBanner.svelte');
const statusCard = source('../src/renderer/app/components/ModelProgressCard.svelte');
const serverView = source('../src/renderer/app/views/ServerView.svelte');

describe('Phase 1 Settings layout contracts', () => {
  test('owns the full-height Eve background from the document to the app shell', () => {
    expect(appHtml).toContain('<html lang="en" class="h-full bg-[#08090a]">');
    expect(appHtml).toContain('<body class="h-full bg-[#08090a]">');
    expect(appHtml).toContain('<div id="app" class="h-full min-h-0 bg-[#08090a]">');
    expect(appCss).toMatch(/html,\s*body,\s*#app\s*\{[\s\S]*?height: 100%;[\s\S]*?background: #08090a;/);
    expect(appView).toContain('class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#08090a]');
    expect(appView).toContain('class="min-h-0 min-w-0 flex-1 overflow-hidden"');
    expect(appView).toContain('hidden={activeView !== \'settings\'}');
  });

  test('uses one in-flow model status region instead of a fixed overlay', () => {
    expect(statusBanner).toContain('data-status-region="model-progress"');
    expect(statusBanner).toContain('class="mx-auto w-full max-w-4xl shrink-0');
    expect(statusBanner).not.toContain('fixed');
    expect(statusBanner).not.toContain('pointer-events-none');
    expect(statusBanner).not.toContain('z-20');
    expect(statusBanner).toContain('Open Settings &gt; Server &amp; diagnostics for details.');
    expect(statusBanner).toContain('<ModelProgressCard state={modelDownload} announce={false} />');
    expect(statusCard).toContain('aria-live={announce ? \'polite\' : undefined}');
    expect(appView).toMatch(/<\/header>[\s\S]*?<ModelProgressBanner visible \/>[\s\S]*?<main id="main-content"/);
  });

  test('keeps Settings as the single page scroll owner while logs remain bounded', () => {
    expect(settingsView.match(/overflow-y-auto/g)?.length).toBe(1);
    expect(settingsView).toContain('data-scroll-owner="settings-page"');
    expect(settingsView).toContain('min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain');
    expect(settingsView).not.toContain('h-screen');
    expect(serverView).toContain("embedded ? 'min-w-0 space-y-6'");
    expect(serverView).toContain('max-h-64 min-h-24 min-w-0 overflow-y-auto overscroll-contain');
  });

  test('stacks labels and controls at narrow widths and contains control content', () => {
    expect(settingsRow).toContain('grid-cols-1');
    expect(settingsRow).toContain('sm:grid-cols-[minmax(0,1fr)_minmax(0,auto)]');
    expect(settingsRow).toContain('min-w-0 w-full max-w-full sm:w-auto');
    expect(settingsRow).toContain('[&>input]:max-w-full');
    expect(settingsRow).toContain('[&>select]:max-w-full');
    expect(settingsRow).toContain('[&_textarea]:focus-visible:ring-2');
    expect(settingsView).toContain('w-full max-w-full');
    expect(settingsView).toContain('sm:w-auto');
  });

  test('associates section headings and form controls with accessible names', () => {
    expect(settingsSection).toContain('aria-labelledby={headingId}');
    expect(settingsSection).toContain('aria-describedby={descriptionId}');
    expect(settingsSection).toContain('id={descriptionId}');
    expect(settingsSection).toContain('<h2 id={headingId}');
    expect(settingsView).toContain('<h1 class="sr-only">Settings</h1>');
    expect(settingsView).toContain('aria-label="Input device"');
    expect(settingsView).toContain('aria-label="Dictation mode"');
    expect(settingsView).toContain('aria-label="Paste method"');
    expect(settingsView).toContain('aria-describedby="hotwords-help"');
    expect(settingsView).toContain('aria-expanded={compatibilityControlsOpen}');
    expect(settingsView).toContain('aria-controls="compatibility-controls"');
  });

  test('keeps generated section heading IDs unique and non-empty while preserving explicit IDs', () => {
    expect(settingsSection).toContain('const componentId = $props.id();');
    expect(settingsSection).toContain("slugify(title) || 'section'");
    expect(settingsSection).toContain('id ?? `settings-section-${slugify(title) || \'section\'}-${componentId}`');
  });

  test('keeps app-level announcements as the sole status announcer', () => {
    expect(serverView).toContain('<ModelProgressCard state={modelDownload} announce={false} />');
    expect(serverView).not.toContain('announce={embedded}');
    expect(appView).toContain('<p class="sr-only" aria-live="polite" aria-atomic="true">{$serverStatusState.announcement}</p>');
    expect(settingsView).toContain('aria-pressed={settings.holdToTalk}');
    expect(settingsView).toContain('aria-pressed={!settings.holdToTalk}');
    expect(settingsView).toContain('data-hotwords-editor');
    expect(settingsView.match(/<select[\s\S]*?cursor-pointer/g)?.length).toBe(7);
  });

  test('keeps the Phase 2 General subgroup foundation aligned with the row primitive', () => {
    expect(settingsGroup).toContain('<h3 id={headingId}');
    expect(settingsGroup).toContain('data-settings-group-surface');
    expect(settingsView).toContain('<SettingsSection title="General"');
    expect(settingsView).toContain('<SettingsGroup title="Shortcuts &amp; activation">');
    expect(settingsView).toContain('<SettingsGroup title="Audio">');
    expect(settingsView).toContain('<SettingsGroup title="Dictation/output">');
    expect(settingsView).toContain('<SettingsGroup title="Hotwords"');
    expect(settingsView).toContain('<SettingsGroup title="App behavior">');
    expect(settingsView).not.toContain('<SettingsSection title="Shortcuts &amp; activation">');
    expect(settingsView).not.toContain('<SettingsSection title="Model compatibility">');
  });

  test('keeps shared focus, forced-colors, and reduced-motion fallbacks intact', () => {
    expect(appCss).toContain('@media (forced-colors: active)');
    expect(appCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(appCss).toContain(':focus-visible');
    expect(settingsRow).toContain('focus-visible:ring-2');
    expect(settingsView).toContain('prefers-reduced-motion');
    expect(statusCard).not.toContain('animate-');
  });
});
