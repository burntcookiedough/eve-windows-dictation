import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { get } from 'svelte/store';
import {
  disposeServerStatus,
  getDownloadMilestone,
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
const cactus = source('../src/renderer/app/components/Cactus.svelte');
const recordingState = source('../src/renderer/app/recording-renderer-state.ts');
const appCss = source('../src/renderer/app/app.css');
const statusController = source('../src/renderer/app/server-status.ts');
const banner = source('../src/renderer/app/components/ModelProgressBanner.svelte');
const card = source('../src/renderer/app/components/ModelProgressCard.svelte');
const serverView = source('../src/renderer/app/views/ServerView.svelte');
const preload = source('../src/main/preload/main.ts');
const declarations = source('../src/renderer/global.d.ts');
const packageJson = source('../package.json');
const serverVersion = source('../../server/src/version.py');

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
    expect(appView).toMatch(/\{ id: 'home', label: 'home' \}[\s\S]*\{ id: 'insights', label: 'insights' \}[\s\S]*\{ id: 'history', label: 'history' \}[\s\S]*\{ id: 'settings', label: 'settings' \}/);
    expect(appView).toContain('<HomeView onNavigate={selectView} />');
    expect(appView).toContain("let visited = $state<Record<PrimaryView, boolean>>({");
    expect(appView).toContain("home: true,");
    expect(appView).toContain("event.key === String(index + 1)");
    expect(appView).toContain('event.defaultPrevented');
    expect(appView).toContain('isEditableTarget(event.target) || hasOpenMenuOrDialog()');
    expect(appView).not.toContain('handleGlobalShortcut, true');
    expect(appView).not.toContain("event.code === 'Space'");
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
    expect(homeView).toContain('window.murmurMain.getSettings()');
    expect(homeView).toContain('window.murmurMain.getInsights(\'today\')');
    expect(homeView).not.toContain('restartServer');
    expect(homeView).not.toContain('startRecording');
    expect(homeView).not.toContain('stopRecording');
    expect(homeView).not.toContain('hold to record');
    expect(cactus).not.toContain('onclick');
    expect(homeView).not.toContain('External server');
    expect(statusController).not.toContain('useExternalServer');
    expect(homeView).toContain("statusAction === 'retry'");
    expect(homeView).toContain('if (retrying) return;');
    expect(homeView).toContain('disabled={retrying}');
    expect(statusController).toContain('if (!initialized || !current.state?.managed || retryInFlight) return false;');
    expect(statusController).toContain('await window.murmurMain.restartServer()');
  });

  test('shares phase and progress UI while retaining factual shortcuts, actions, and restrained live announcements', () => {
    expect(appView).toContain("visible={activeView === 'history' || activeView === 'insights'}");
    expect(homeView).not.toContain('ModelProgressCard');
    expect(homeView).not.toContain('shouldShowModelProgress');
    expect(homeView).toContain('getHotkeyDisplayName(settings.hotkey)');
    expect(homeView).toContain('getHotkeyDisplayName(settings.longHotkey)');
    expect(homeView).toContain("onNavigate('settings')");
    expect(homeView).toContain('onNewHistoryEntry');
    expect(homeView).toContain('latestEntry = entry;');
    expect(appView).toContain('aria-live="polite"');
    expect(statusController).toContain('percent < 25');
    expect(card).toContain("aria-live={announce ? 'polite' : undefined}");
    expect(banner).not.toContain('aria-live="assertive"');
    expect(serverView.match(/aria-live="polite"/g)?.length).toBe(1);
    expect(serverView).toContain('data-server-logs-loading role="status" aria-live="polite"');
    expect(appView).toContain('aria-live="polite"');
    expect(serverView).toContain('let active = true;');
    expect(serverView).toContain('if (!active) return;');
    expect(banner).toContain('>settings</button>');
    expect(banner).toContain('onclick={onNavigate}');
    expect(homeView).not.toContain('Open Server and use Restart');
  });

  test('keeps detected development servers separate from managed retry actions', () => {
    expect(getServerStatusPhase({ status: 'running', managed: false, engineStatus: { current: 'whisper', status: 'ready' } })).toBe('ready');
    expect(statusController).toContain('!current.state?.managed');
    expect(homeView).not.toContain('getServerManagementMode');
    expect(banner).not.toContain('getServerManagementMode');
  });

  test('uses real Home activity, passive recording feedback, and the prototype cactus artwork', () => {
    expect(homeView).toContain('home-presence');
    expect(homeView).toContain('home-activity-grid');
    expect(homeView).toContain('getInsights(\'today\')');
    expect(homeView).toContain('yearActivity');
    expect(homeView).toContain('getHistoryEntries(0, 1)');
    expect(homeView).toContain('insights?.hasData === false');
    expect(homeView).toContain('motion.audioLevel');
    expect(homeView).toContain("setInterval(() => {");
    expect(homeView).toContain('}, 1000);');
    expect(homeView).toContain("if (localDayKey(now) !== previousDay)");
    expect(homeView).toContain("window.addEventListener('history-delete-committed', refreshAfterDelete)");
    expect(homeView).toContain("window.removeEventListener('history-delete-committed', refreshAfterDelete)");
    expect(homeView).toContain('if (active && historyRevision === revision)');
    expect(homeView).toContain("return 'dictation error'");
    expect(homeView).not.toContain('goal');
    expect(homeView).not.toContain('Your words, ready to move');
    expect(cactus).toContain('M100 152 H82 Q60 152 60 130 V106');
    expect(cactus).toContain('M100 124 H120 Q142 124 142 102 V78');
    expect(cactus).toContain('M100 214 V50');
    expect(recordingState).toContain('if (currentLifecycle !== lifecycle) return;');
    expect(appCss).toContain('@media (max-width: 440px)');
    expect(appCss).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('preserves the frozen Eve identity and cross-runtime version baseline', () => {
    const appVersion = (JSON.parse(packageJson) as { version: string }).version;
    const backendVersion = serverVersion.match(/^SERVER_VERSION = "([^"]+)"$/m)?.[1];
    const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    for (const version of ['1.2.3-beta.2+exp.sha.5114f85', '0.8.2-alpha.1']) {
      expect(version).toMatch(semverPattern);
    }
    for (const version of ['1.2.3-', '1.2.3-alpha.', '1.2.3-alpha..1', '1.2.3-alpha.01']) {
      expect(version).not.toMatch(semverPattern);
    }
    expect(appVersion).toMatch(semverPattern);
    expect(appVersion).toBe(backendVersion);
    expect(packageJson).toContain('"appId": "io.github.burntcookiedough.eve"');
    expect(packageJson).toContain('"guid": "0204d005-75b3-5b31-b1f6-ef2831e2b204"');
  });
});
