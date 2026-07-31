import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { get } from 'svelte/store';
import {
  disposeServerStatus,
  getDownloadMilestone,
  getServerManagementMode,
  getServerStatusPhase,
  initializeServerStatus,
  refresh,
  retryManagedServer,
  serverStatusState,
} from '../src/renderer/app/server-status';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const appView = source('../src/renderer/app/App.svelte');
const homeView = source('../src/renderer/app/views/HomeView.svelte');
const statusController = source('../src/renderer/app/server-status.ts');
const banner = source('../src/renderer/app/components/ModelProgressBanner.svelte');
const card = source('../src/renderer/app/components/ModelProgressCard.svelte');
const serverView = source('../src/renderer/app/views/ServerView.svelte');
const preload = source('../src/main/preload/main.ts');
const declarations = source('../src/renderer/global.d.ts');
const packageJson = source('../package.json');

describe('Home and shared server status', () => {
  test('initializes one subscription, reseeds on focus, and tears down only its own listener', async () => {
    let getCalls = 0;
    let stateSubscriptions = 0;
    let stateUnsubscriptions = 0;
    let focusHandler: (() => void) | undefined;
    let removedFocusHandler: (() => void) | undefined;
    const ready = { status: 'running' as const, managed: true, engineStatus: { current: 'whisper', status: 'ready' as const } };

    (globalThis as { window: unknown }).window = {
      murmurMain: {
        getServerStatus: async () => { getCalls += 1; return ready; },
        onServerStateChange: () => { stateSubscriptions += 1; return () => { stateUnsubscriptions += 1; }; },
        restartServer: async () => ready,
      },
      addEventListener: (_type: string, handler: () => void) => { focusHandler = handler; },
      removeEventListener: (_type: string, handler: () => void) => { removedFocusHandler = handler; },
    };

    initializeServerStatus();
    initializeServerStatus();
    await Promise.resolve();
    expect(stateSubscriptions).toBe(1);
    expect(getCalls).toBe(1);
    expect(get(serverStatusState).phase).toBe('ready');

    focusHandler?.();
    await Promise.resolve();
    expect(getCalls).toBe(2);

    disposeServerStatus();
    expect(stateUnsubscriptions).toBe(1);
    expect(removedFocusHandler).toBe(focusHandler);
  });

  test('clears a previously ready snapshot after a refresh failure and retries only managed servers', async () => {
    let resolveStatus = true;
    let restartCalls = 0;
    let stateCallback: ((state: { status: 'running'; managed: boolean; engineStatus: { current: string; status: 'ready' } }) => void) | undefined;
    const ready = { status: 'running' as const, managed: true, engineStatus: { current: 'whisper', status: 'ready' as const } };

    (globalThis as { window: unknown }).window = {
      murmurMain: {
        getServerStatus: async () => {
          if (!resolveStatus) throw new Error('offline');
          return ready;
        },
        onServerStateChange: (callback: typeof stateCallback) => { stateCallback = callback; return () => {}; },
        restartServer: async () => { restartCalls += 1; return ready; },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    initializeServerStatus();
    await Promise.resolve();
    expect(await retryManagedServer()).toBeTrue();
    expect(restartCalls).toBe(1);

    resolveStatus = false;
    await refresh();
    expect(get(serverStatusState)).toMatchObject({ state: null, phase: 'unavailable' });

    stateCallback?.({ ...ready, managed: false });
    expect(await retryManagedServer()).toBeFalse();
    expect(restartCalls).toBe(1);
    disposeServerStatus();
  });

  test('does not let an older status snapshot overwrite an event or a new controller lifecycle', async () => {
    let resolveFirstStatus: ((state: { status: 'running'; managed: boolean; engineStatus: { current: string; status: 'ready' } }) => void) | undefined;
    const firstStatus = new Promise<{ status: 'running'; managed: boolean; engineStatus: { current: string; status: 'ready' } }>((resolve) => {
      resolveFirstStatus = resolve;
    });
    let stateCallback: ((state: { status: 'running'; managed: boolean; engineStatus: { current: string; status: 'ready' } }) => void) | undefined;
    const eventStatus = { status: 'running' as const, managed: false, engineStatus: { current: 'event', status: 'ready' as const } };
    const reinitializedStatus = { status: 'running' as const, managed: true, engineStatus: { current: 'new', status: 'ready' as const } };

    (globalThis as { window: unknown }).window = {
      murmurMain: {
        getServerStatus: async () => firstStatus,
        onServerStateChange: (callback: typeof stateCallback) => { stateCallback = callback; return () => {}; },
        restartServer: async () => reinitializedStatus,
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    initializeServerStatus();
    stateCallback?.(eventStatus);
    resolveFirstStatus?.({ status: 'running', managed: true, engineStatus: { current: 'old', status: 'ready' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(get(serverStatusState).state).toEqual(eventStatus);

    disposeServerStatus();
    let resolveDisposedStatus: ((state: typeof reinitializedStatus) => void) | undefined;
    const disposedStatus = new Promise<typeof reinitializedStatus>((resolve) => {
      resolveDisposedStatus = resolve;
    });
    (globalThis as { window: { murmurMain: { getServerStatus: () => Promise<typeof reinitializedStatus> } } }).window.murmurMain.getServerStatus = async () => disposedStatus;
    initializeServerStatus();
    disposeServerStatus();
    (globalThis as { window: { murmurMain: { getServerStatus: () => Promise<typeof reinitializedStatus> } } }).window.murmurMain.getServerStatus = async () => reinitializedStatus;
    initializeServerStatus();
    await Promise.resolve();
    resolveDisposedStatus?.({ status: 'running', managed: false, engineStatus: { current: 'disposed', status: 'ready' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(get(serverStatusState).state).toEqual(reinitializedStatus);
    disposeServerStatus();
  });

  test('makes Home the default and keeps primary navigation in the required order', () => {
    expect(appView).toContain("let activeView = $state<View>('home')");
    expect(appView).toMatch(/\{ id: 'home', label: 'Home' \}[\s\S]*\{ id: 'history', label: 'History' \}[\s\S]*\{ id: 'insights', label: 'Insights' \}[\s\S]*\{ id: 'settings', label: 'Settings' \}/);
    expect(appView).toContain('<HomeView onNavigate={selectView} />');
    expect(appView).toContain("return match?.id ?? 'home'");
  });

  test('covers connecting, stale, unavailable, model, loading, ready, and error phases without stale Ready', () => {
    expect(getServerStatusPhase(null)).toBe('unavailable');
    expect(getServerStatusPhase({ status: 'starting', managed: true })).toBe('connecting');
    expect(getServerStatusPhase({ status: 'idle', managed: true })).toBe('stale');
    expect(getServerStatusPhase({ status: 'running', managed: true, modelDownload: { model: 'm', size_gb: 1, status: 'missing' } })).toBe('missing');
    expect(getServerStatusPhase({ status: 'running', managed: true, modelDownload: { model: 'm', size_gb: 1, status: 'partial' } })).toBe('partial');
    expect(getServerStatusPhase({ status: 'running', managed: true, modelDownload: { model: 'm', size_gb: 1, status: 'missing', phase: 'checking' } })).toBe('checking');
    expect(getServerStatusPhase({ status: 'running', managed: true, modelDownload: { model: 'm', size_gb: 1, status: 'downloading' } })).toBe('downloading');
    expect(getServerStatusPhase({ status: 'running', managed: true, engineStatus: { current: 'whisper', status: 'loading' } })).toBe('loading');
    expect(getServerStatusPhase({ status: 'running', managed: true, engineStatus: { current: 'whisper', status: 'ready' } })).toBe('ready');
    expect(getServerStatusPhase({ status: 'error', managed: true })).toBe('error');
    expect(statusController).toContain('publish(null);');
  });

  test('announces only bounded download milestones after 25%', () => {
    expect(getDownloadMilestone(0)).toBeNull();
    expect(getDownloadMilestone(24)).toBeNull();
    expect(getDownloadMilestone(25)).toBe(25);
    expect(getDownloadMilestone(50)).toBe(50);
    expect(getDownloadMilestone(75)).toBe(75);
    expect(getDownloadMilestone(100)).toBe(100);
    expect(getDownloadMilestone(99)).toBe(75);
  });

  test('owns one root subscription and bounded transfer-only polling with cleanup', () => {
    expect(statusController).toContain('let unsubscribe: (() => void) | null = null;');
    expect(statusController).toContain('unsubscribe = window.murmurMain.onServerStateChange');
    expect(statusController).toContain("window.addEventListener('focus', reseedOnFocus);");
    expect(statusController).toContain('shouldShowModelProgress(current.state.modelDownload)');
    expect(statusController).toContain('setTimeout(() => void refresh(), 3000)');
    expect(statusController).toContain('unsubscribe?.();');
    expect(statusController).toContain("window.removeEventListener('focus', reseedOnFocus);");
    expect(statusController).not.toContain('setInterval');
    expect(statusController).toContain('lifecycleGeneration');
    expect(statusController).toContain('eventRevision');
    expect(banner).not.toContain('getServerStatus');
    expect(banner).not.toContain('onMount');
  });

  test('uses individual preload unsubscriptions so the settings view cannot remove root state listeners', () => {
    expect(preload).toContain('return () => ipcRenderer.removeListener(IPC_CHANNELS.SERVER_STATE_CHANGE, handler);');
    expect(preload).toContain('return () => ipcRenderer.removeListener(IPC_CHANNELS.SERVER_LOG, handler);');
    expect(declarations).toContain('onServerStateChange: (callback: (state: ServerStatePayload) => void) => () => void;');
    expect(serverView).toContain('removeLogListener = window.murmurMain.onServerLog');
    expect(serverView).toContain('removeLogListener?.();');
    expect(serverView).not.toContain('removeServerListeners();');
    expect(serverView).not.toContain('onServerStateChange((state)');
  });

  test('keeps Home read-only until an explicit managed retry click', () => {
    const mount = homeView.match(/async function loadSettings\(\): Promise<void> \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    expect(mount).toContain('getSettings');
    expect(mount).not.toContain('restartServer');
    expect(mount).not.toContain('updateServerSettings');
    expect(homeView).toContain('onclick={retry}');
    expect(homeView).toContain('External server — Eve cannot restart this endpoint.');
    expect(homeView).toContain('Management mode cannot be confirmed. Open Settings &gt; Advanced.');
    expect(statusController).toContain('const settings = await window.murmurMain.getSettings();');
    expect(statusController).toContain('setConfiguredExternalServer(settings.useExternalServer);');
    expect(homeView).toContain('if (retrying) return;');
    expect(homeView).toContain('disabled={retrying}');
    expect(statusController).toContain('if (!initialized || !current.state?.managed || retryInFlight) return false;');
    expect(statusController).toContain('await window.murmurMain.restartServer()');
  });

  test('shares phase and progress UI while retaining factual shortcuts, privacy, actions, and restrained live announcements', () => {
    expect(homeView).toContain('<ModelProgressCard state={model ?? undefined} announce={false} />');
    expect(homeView).toContain('getHotkeyDisplayName(settings.hotkey)');
    expect(homeView).toContain('getHotkeyDisplayName(settings.longHotkey)');
    expect(homeView).toContain('does not automatically import personal data');
    expect(homeView).toContain("onNavigate('history')");
    expect(homeView).toContain("onNavigate('insights')");
    expect(homeView).toContain("onNavigate('settings')");
    expect(appView).toContain('aria-live="polite"');
    expect(statusController).toContain('percent < 25');
    expect(card).toContain("aria-live={announce ? 'polite' : undefined}");
    expect(banner).not.toContain('aria-live="assertive"');
    expect(serverView).not.toContain('aria-live="polite"');
    expect(appView).toContain('aria-live="polite"');
    expect(serverView).toContain('let active = true;');
    expect(serverView).toContain('if (!active) return;');
    expect(banner).toContain('Open Settings &gt; Advanced for details.');
    expect(banner).not.toContain('Open Server and use Restart');
    expect(homeView).toContain('By default, Eve processes speech locally.');
    expect(homeView).toContain('audio is sent to that endpoint under your control.');
  });

  test('shares external management truth and retains a forced-colors focus fallback', () => {
    expect(getServerManagementMode({ state: null, phase: 'unavailable', announcement: '', configuredExternalServer: null })).toBe('unknown');
    expect(getServerManagementMode({ state: null, phase: 'unavailable', announcement: '', configuredExternalServer: true })).toBe('external');
    expect(getServerManagementMode({ state: { status: 'running', managed: true }, phase: 'stale', announcement: '', configuredExternalServer: false })).toBe('managed');
    expect(homeView).toContain('focus-visible:outline-hidden');
    expect(banner).toContain('getServerManagementMode($serverStatusState)');
  });

  test('preserves the frozen Eve identity and v0.8.0 version baseline', () => {
    expect(packageJson).toContain('"version": "0.8.0"');
    expect(packageJson).toContain('"appId": "io.github.burntcookiedough.eve"');
    expect(packageJson).toContain('"guid": "0204d005-75b3-5b31-b1f6-ef2831e2b204"');
  });
});
