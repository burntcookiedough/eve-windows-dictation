import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const settingsView = source('../src/renderer/app/views/SettingsView.svelte');
const serverView = source('../src/renderer/app/views/ServerView.svelte');
const serverFixture = source('../src/renderer/app/fixtures/SettingsServerFixture.svelte');
const settingsRow = source('../src/renderer/app/components/SettingsRow.svelte');
const appCss = source('../src/renderer/app/app.css');
const primaryPage = source('../src/renderer/app/components/PrimaryPage.svelte');

describe('Settings server and diagnostics contracts', () => {
  test('keeps server status in Engine and nests full diagnostics under Advanced', () => {
    expect(settingsView).toContain('<SettingsSection title="Engine"');
    expect(settingsView).toContain('data-server-diagnostics');
    expect(settingsView).toContain('<ServerView embedded showAutoStart={false} />');
    expect(settingsView).toContain('label="Server"');
    expect(settingsView).toContain('label="Auto-start server"');
    expect(settingsView).toContain('title="Advanced"');
    expect(settingsView).not.toContain('<SettingsSection title="Server">');
    expect(serverView).not.toContain('<SettingsSection');
    expect(serverView).not.toContain('title="Settings"');
    expect(serverView).toContain('const headingTag = $derived(embedded ? \'h3\' : \'h2\')');
    expect(serverView).toContain('aria-labelledby={headingId(');
  });

  test('keeps managed lifecycle, health, diagnostics, and logs together', () => {
    expect(settingsView).not.toContain('data-server-mode-surface');
    expect(settingsView).not.toContain('Use external server');
    expect(settingsView).not.toContain('data-external-server-panel');
    expect(serverFixture).not.toContain('external');
    expect(serverView).toContain('data-server-section="management"');
    expect(serverView).toContain('label="Auto-start server"');
    expect(serverView).not.toContain('externalMode');
    expect(serverView).not.toContain('data-server-action-restriction');
    expect(serverView).toContain('window.murmurMain.startServer()');
    expect(serverView).toContain('window.murmurMain.stopServer()');
    expect(serverView).toContain('window.murmurMain.restartServer()');
    expect(serverView).toContain('showAutoStart?: boolean;');
    expect(serverView).toContain('showAutoStart = true');
    expect(serverView).toContain('{#if showAutoStart}');
  });

  test('keeps factual status and diagnostics readable without duplicating app announcements', () => {
    expect(serverView).toContain('data-server-health-status');
    expect(serverView).toContain('data-server-health-details');
    expect(serverView).toContain('md:grid-cols-[auto_minmax(0,1fr)_auto]');
    expect(serverView).toContain('data-server-status');
    expect(serverView).toContain('data-server-diagnostic-warnings');
    expect(serverView).toContain('<ModelProgressCard state={modelDownload} announce={false} />');
    expect(serverView).toContain('aria-describedby={diagnosticsStatusId}');
    expect(serverView).toContain('id={diagnosticsStatusId}');
    expect(serverView.match(/aria-live="polite"/g)?.length).toBe(1);
    expect(serverView).toContain('data-server-logs-loading role="status" aria-live="polite"');
    expect(serverView).not.toContain('aria-label={`Server status: ${statusDisplay.label}`}');
    expect(serverView).toContain('motion-safe:animate-ping');
    expect(serverView).toContain('.server-settings-embedded');
    expect(serverView).toContain('var(--fg2, #9b9b9b) !important');
    expect(serverView).toContain('button:hover:not(:disabled)');
    expect(settingsRow).toContain(':global(:focus-visible)');
    expect(appCss).toContain('@media (forced-colors: active)');
    expect(appCss).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('makes logs the only bounded nested scroller and keeps the privacy warning visible', () => {
    expect(serverView).toContain('data-server-logs-toggle');
    expect(serverView).toContain('aria-expanded={showLogs}');
    expect(serverView).toContain('aria-controls={logOutputId}');
    expect(serverView).toContain('aria-describedby={privacyWarningId}');
    expect(serverView).toContain('id={logOutputId} hidden={!showLogs}');
    expect(serverView).toContain('data-server-logs-privacy');
    expect(serverView).toContain('data-server-log-output');
    expect(serverView).toContain('tabindex="0"');
    expect(serverView).toContain('role="log"');
    expect(serverView).toContain('aria-label="Server log output"');
    expect(serverView).toContain('data-log-size={logBodySize}');
    expect(serverView).toContain("${logBodySize === 'long' ? 'max-h-64 overflow-y-auto overscroll-contain' : 'min-h-16 overflow-hidden'}");
    expect(serverView).toContain('data-server-logs-state="loading"');
    expect(serverView).toContain('data-server-logs-state="error"');
    expect(serverView).toContain('data-server-logs-state="empty"');
    expect(serverView).toContain('SERVER_LOG_LOAD_ERROR');
    expect(serverView).not.toContain('data-server-logs-surface class="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-4 focus-within');
    expect(serverView).toContain('focus:outline-offset-[-2px]');
    expect(serverView).not.toContain('opacity-45 pointer-events-none select-none');
  });

  test('keeps the Settings page as the only page-level scroll owner and wraps long controls', () => {
    expect(settingsView).not.toContain('overflow-y-auto');
    expect(settingsView).toContain('<PrimaryPage page="settings" scrollOwner="settings-page"');
    expect(primaryPage).toContain('data-scroll-owner={scrollOwner}');
    expect(primaryPage).toContain('class="primary-page__scroll"');
    expect(appCss).toContain('.primary-page__scroll {');
    expect(appCss).toContain('overflow-y: auto;');
    expect(settingsView).toContain('options={toWhisperLanguageOptions()}');
    expect(serverView).toContain('[overflow-wrap:anywhere]');
    expect(serverView).toContain('serverState.version !== undefined');
    expect(serverView).toContain('serverState.uptime !== undefined');
  });
});
