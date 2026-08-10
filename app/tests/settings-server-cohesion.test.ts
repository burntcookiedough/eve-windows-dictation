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

describe('Phase 3 Server and diagnostics cohesion contracts', () => {
  test('uses one cohesive Server & diagnostics section without nested SettingsSection composition', () => {
    expect(settingsView).toContain('title="Server &amp; diagnostics"');
    expect(settingsView).toContain('data-server-diagnostics');
    expect(settingsView).toContain('<ServerView embedded externalMode={externalMode} />');
    expect(settingsView).not.toContain('<SettingsSection title="Server">');
    expect(serverView).not.toContain('<SettingsSection');
    expect(serverView).not.toContain('title="Settings"');
    expect(serverView).toContain('const headingTag = $derived(embedded ? \'h3\' : \'h2\')');
    expect(serverView).toContain('aria-labelledby={headingId(');
  });

  test('keeps management mode, endpoint, auto-start, health, and truthful external restrictions together', () => {
    expect(settingsView).toContain('data-server-management');
    expect(settingsView).toContain('data-server-mode-surface');
    expect(settingsView).toContain('label="Use external server"');
    expect(settingsView).toContain('data-external-server-panel');
    expect(serverFixture).toContain('{#if externalEnabled}');
    expect(serverView).toContain('data-server-section="management"');
    expect(serverView).toContain('label="Auto-start server"');
    expect(serverView).toContain('disabled={externalMode}');
    expect(serverView).toContain('data-server-action-restriction');
    expect(serverView.match(/!externalMode &&/g)?.length).toBe(3);
    expect(serverView).toContain('getServerManagementMode');
    expect(serverView).toContain('Management mode &amp; endpoint section above.');
    expect(serverView).toContain('Settings &gt; Server &amp; diagnostics.');
    expect(serverView).toContain('window.murmurMain.startServer()');
    expect(serverView).toContain('window.murmurMain.stopServer()');
    expect(serverView).toContain('window.murmurMain.restartServer()');
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
    expect(settingsRow).toContain('focus-visible:ring-2');
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
    expect(primaryPage).toContain('overflow-x-hidden overflow-y-auto overscroll-contain');
    expect(settingsView).toContain('min-h-9 w-full max-w-full rounded-lg border border-zinc-700');
    expect(settingsView).toContain('[overflow-wrap:anywhere]');
    expect(serverView).toContain('[overflow-wrap:anywhere]');
    expect(serverView).toContain('serverState.version !== undefined');
    expect(serverView).toContain('serverState.uptime !== undefined');
  });
});
