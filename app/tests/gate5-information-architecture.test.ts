import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const appView = source('../src/renderer/app/App.svelte');
const bottomSheet = source('../src/renderer/app/components/SettingsBottomSheet.svelte');
const settingsView = source('../src/renderer/app/views/SettingsView.svelte');
const serverView = source('../src/renderer/app/views/ServerView.svelte');

describe('Gate 5 information architecture', () => {
  test('keeps production navigation to Home, History, Insights, and Settings', () => {
    expect(appView).toContain("const primaryTabs");
    expect(appView).toContain("{ id: 'home', label: 'home' }");
    expect(appView).toContain("{ id: 'insights', label: 'insights' }");
    expect(appView).toContain("{ id: 'history', label: 'history' }");
    expect(appView).toContain("{ id: 'settings', label: 'settings' }");
    expect(appView).not.toContain("{ id: 'server', label: 'Server' }");
    expect(appView).not.toContain("{ id: 'test', label: 'Lab' }");
  });

  test('keeps the test view reachable only by a development shortcut', () => {
    expect(appView).toContain("if (import.meta.env.DEV && event.key === '0')");
    expect(appView).toContain('testVisited = true;');
    expect(appView).toContain("<TestView />");
  });

  test('keeps number navigation aligned with the visible tab order', () => {
    expect(appView).toContain('event.key === String(index + 1)');
    expect(appView).toContain('event.defaultPrevented');
    expect(appView).toContain('isEditableTarget(event.target) || hasOpenMenuOrDialog()');
    expect(appView).toContain('hasVisibleNavigationBlocker(');
    expect(appView).toContain('bounds.width > 0 && bounds.height > 0');
    expect(bottomSheet).toContain('aria-hidden={!open} inert={!open}');
    expect(appView).toContain('aria-current={activeView === tab.id ? \'page\' : undefined}');
    expect(appView).toContain('app-nav__indicator');
  });

  test('keeps server controls in Engine and embeds diagnostics in its disclosure', () => {
    expect(settingsView).toContain("import ServerView");
    expect(settingsView).toContain('<SettingsSection title="Engine"');
    expect(settingsView).toContain('label="Server"');
    expect(settingsView).toContain('title="Diagnostics"');
    expect(settingsView).toContain('data-server-diagnostics');
    expect(settingsView).toContain('<ServerView embedded showAutoStart={false} />');

    for (const operation of [
      'startServer',
      'stopServer',
      'restartServer',
      'getServerLogs',
      'updateSetting',
    ]) {
      expect(serverView).toContain(`window.murmurMain.${operation}`);
    }
    expect(serverView).toContain('serverStatusState');
  });
});
