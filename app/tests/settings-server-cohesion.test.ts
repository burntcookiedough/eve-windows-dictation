import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const settingsView = source('../src/renderer/app/views/SettingsView.svelte');
const serverView = source('../src/renderer/app/views/ServerView.svelte');
const settingsRow = source('../src/renderer/app/components/SettingsRow.svelte');
const appCss = source('../src/renderer/app/app.css');

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
    expect(serverView).toContain('data-server-section="management"');
    expect(serverView).toContain('label="Auto-start server"');
    expect(serverView).toContain('disabled={externalMode}');
    expect(serverView).toContain('data-server-action-restriction');
    expect(serverView).toContain('!externalMode &&');
    expect(serverView).toContain('window.murmurMain.startServer()');
    expect(serverView).toContain('window.murmurMain.stopServer()');
    expect(serverView).toContain('window.murmurMain.restartServer()');
  });

  test('keeps factual status and diagnostics readable without creating another live announcer', () => {
    expect(serverView).toContain('data-server-health-status');
    expect(serverView).toContain('data-server-status');
    expect(serverView).toContain('data-server-diagnostic-warnings');
    expect(serverView).toContain('<ModelProgressCard state={modelDownload} announce={false} />');
    expect(serverView).not.toContain('aria-live="polite"');
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
    expect(serverView).toContain('max-h-64 min-h-24 min-w-0 overflow-y-auto overscroll-contain');
    expect(serverView).toContain('focus-within:ring-2');
    expect(serverView).not.toContain('pointer-events-none');
  });

  test('keeps the Settings page as the only page-level scroll owner and wraps long controls', () => {
    expect(settingsView.match(/overflow-y-auto/g)?.length).toBe(1);
    expect(settingsView).toContain('data-scroll-owner="settings-page"');
    expect(settingsView).toContain('min-h-9 w-full max-w-full rounded-lg border border-zinc-700');
    expect(settingsView).toContain('[overflow-wrap:anywhere]');
    expect(serverView).toContain('[overflow-wrap:anywhere]');
  });
});
