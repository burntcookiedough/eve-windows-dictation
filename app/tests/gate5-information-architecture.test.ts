import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const appView = source('../src/renderer/app/App.svelte');
const settingsView = source('../src/renderer/app/views/SettingsView.svelte');
const serverView = source('../src/renderer/app/views/ServerView.svelte');

describe('Gate 5 information architecture', () => {
  test('keeps production navigation to History, Insights, and Settings', () => {
    expect(appView).toContain("const primaryTabs");
    expect(appView).toContain("{ id: 'history', label: 'History' }");
    expect(appView).toContain("{ id: 'insights', label: 'Insights' }");
    expect(appView).toContain("{ id: 'settings', label: 'Settings' }");
    expect(appView).not.toContain("{ id: 'server', label: 'Server' }");
  });

  test('keeps Lab source-preserved and development-only', () => {
    expect(appView).toContain("import.meta.env.DEV");
    expect(appView).toContain("{ id: 'test', label: 'Lab' }");
    expect(appView).toContain("<TestView />");
  });

  test('falls back to History for unknown internal views', () => {
    expect(appView).toContain("function resolveView");
    expect(appView).toContain("return match?.id ?? 'history'");
  });

  test('embeds every existing server surface under Settings Advanced', () => {
    expect(settingsView).toContain("import ServerView");
    expect(settingsView).toContain('id="advanced-settings-heading"');
    expect(settingsView).toContain("<ServerView embedded />");

    for (const operation of [
      'getServerStatus',
      'startServer',
      'stopServer',
      'restartServer',
      'getServerLogs',
      'updateSetting',
    ]) {
      expect(serverView).toContain(`window.murmurMain.${operation}`);
    }
  });
});
