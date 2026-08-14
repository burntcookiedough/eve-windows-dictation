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
const primaryPage = source('../src/renderer/app/components/PrimaryPage.svelte');
const eveDropdown = source('../src/renderer/app/components/EveDropdown.svelte');
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
    expect(settingsView).not.toContain('overflow-y-auto');
    expect(primaryPage).toContain('data-scroll-owner={scrollOwner}');
    expect(primaryPage).toContain('overflow-x-hidden overflow-y-auto overscroll-contain');
    expect(settingsView).toContain('<PrimaryPage page="settings" scrollOwner="settings-page"');
    expect(settingsView).not.toContain('h-screen');
    expect(serverView).toContain("embedded ? 'min-w-0 space-y-6'");
    expect(serverView).toContain("${logBodySize === 'long' ? 'max-h-64 overflow-y-auto overscroll-contain' : 'min-h-16 overflow-hidden'}");
  });

  test('keeps controls trailing at every width and contains control content', () => {
    expect(settingsRow).toContain('grid-cols-[minmax(0,1fr)_minmax(5rem,45%)]');
    expect(settingsRow).toContain('items-center');
    expect(settingsRow).toContain('items-center justify-end justify-self-end');
    expect(settingsRow).toContain('min-w-0 w-full max-w-full items-center justify-end justify-self-end');
    expect(settingsRow).toContain('[&>input]:max-w-full');
    expect(settingsRow).toContain('[&>[data-eve-dropdown]]:max-w-full');
    expect(eveDropdown).toContain('data-eve-dropdown');
    expect(settingsRow).toContain('[&_textarea]:focus-visible:ring-2');
    expect(settingsView).toContain('w-full max-w-full');
    expect(eveDropdown).toContain('sm:w-auto');
  });

  test('disables page scroll anchoring and avoids programmatic scroll jumps', () => {
    expect(primaryPage).toContain('[overflow-anchor:none]');
    expect(primaryPage).toContain('[scroll-behavior:auto]');
    expect(settingsView).not.toContain('scrollIntoView');
    expect(settingsView).not.toContain('startViewTransition');
  });

  test('associates section headings and form controls with accessible names', () => {
    expect(settingsSection).toContain('aria-labelledby={headingId}');
    expect(settingsSection).toContain('aria-describedby={descriptionId}');
    expect(settingsSection).toContain('id={descriptionId}');
    expect(settingsSection).toContain('<h2 id={headingId}');
    expect(settingsView).toContain('<h1 class="sr-only">Settings</h1>');
    expect(settingsView).toContain('label="Input device"');
    expect(settingsView).toContain('label="Dictation mode"');
    expect(settingsView).toContain('label="Paste method"');
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
    expect(settingsView.match(/<EveDropdown\b/g)?.length).toBe(6);
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
    expect(primaryPage).toContain('[scroll-behavior:auto]');
    expect(statusCard).not.toContain('animate-');
  });
});
