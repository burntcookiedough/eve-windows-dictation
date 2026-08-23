import { mount } from 'svelte';
import type { ServerLogEntry, ServerStatePayload } from '$shared/types';
import { DEFAULT_SETTINGS } from '$shared/types';
import { serverStatusState } from '../server-status';
import SettingsServerFixture from './SettingsServerFixture.svelte';
import '../app.css';

type FixtureState =
  | 'managed-ready'
  | 'managed-error'
  | 'managed-long'
  | 'managed-short'
  | 'managed-empty'
  | 'managed-log-error'
  | 'managed-log-loading';

const params = new URLSearchParams(globalThis.location.search);
const fixtureState = (params.get('state') ?? 'managed-ready') as FixtureState;
const longStrings = fixtureState === 'managed-long';
const hasError = fixtureState === 'managed-error';
const logError = fixtureState === 'managed-log-error';
const logLoading = fixtureState === 'managed-log-loading';
const logCount = fixtureState === 'managed-short' ? 3 : fixtureState === 'managed-empty' || logError || logLoading ? 0 : 42;

const longWarning = 'The fixture warning deliberately contains a long diagnostic explanation with a host, a compatibility hint, and a recovery action so responsive wrapping can be measured without accessing personal data.';
const engineStatus = {
  current: 'whisper',
  status: hasError ? 'error' as const : 'ready' as const,
  message: hasError ? 'The fixture engine could not load because the selected compatibility configuration needs attention.' : undefined,
  info: {
    id: 'whisper',
    name: longStrings ? 'Faster-Whisper fixture engine with a deliberately long descriptive name' : 'Faster-Whisper',
    model: 'large-v3-turbo',
    supports_hotwords: true,
    languages: ['en', 'fr', 'de'],
    model_size_gb: 1.5,
    gpu_name: longStrings ? 'Fixture GPU with an intentionally long hardware label for wrapping' : 'Fixture GPU',
    gpu_vram_gb: 16,
  },
};

const serverState: ServerStatePayload = {
  status: hasError ? 'error' : 'running',
  managed: true,
  pid: 4242,
  port: 51717,
  version: longStrings ? '0.8.0-fixture-build-with-a-long-version-label' : '0.8.0',
  uptime: 3725000,
  error: hasError ? 'The managed server reported a recoverable fixture failure with a deliberately long message for wrapping.' : undefined,
  engineStatus,
  diagnostics: {
    generated_at: '2026-08-03T00:00:00.000Z',
    cuda: { available: true, device: 'cuda' },
    cuda_dlls: { available: true },
    nvidia_driver: { available: true, version: 'fixture' },
    vc_redist: { required: false },
    warnings: longStrings || hasError
      ? [{
          code: hasError ? 'fixture-engine-error' : 'fixture-long-warning',
          message: hasError ? longWarning : longWarning,
          action: 'Review the compatibility controls before retrying.',
          severity: hasError ? 'error' as const : 'warning' as const,
        }]
      : [],
  },
};

const logs: ServerLogEntry[] = Array.from({ length: logCount }, (_, index) => ({
  timestamp: Date.UTC(2026, 7, 3, 12, 0, index),
  level: index % 11 === 0 ? 'stderr' : 'stdout',
  message: longStrings
    ? `Fixture log ${index + 1}: a deliberately long, privacy-safe diagnostic line that wraps at narrow widths without exposing a real path, transcript, or profile value.`
    : `Fixture server log entry ${index + 1}: readiness check complete.`,
}));

const fixtureSettings = {
  ...DEFAULT_SETTINGS,
};

serverStatusState.set({
  state: serverState,
  phase: hasError ? 'error' : 'ready',
  announcement: '',
});

const fixtureMain = {
  getServerLogs: async () => {
    if (logLoading) return new Promise<ServerLogEntry[]>(() => {});
    if (logError) throw new Error('fixture log retrieval failed');
    return logs;
  },
  getSettings: async () => fixtureSettings,
  onServerLog: (_callback: (entry: ServerLogEntry) => void) => () => {},
  copyDiagnostics: async () => {},
  copyToClipboard: (_text: string) => {},
  startServer: async () => serverState,
  stopServer: async () => serverState,
  restartServer: async () => serverState,
  updateSetting: async (_key: string, _value: unknown) => {},
};

Object.defineProperty(window, 'murmurMain', {
  configurable: true,
  value: fixtureMain,
});

const target = document.querySelector('#fixture-root');
if (!target) throw new Error('Settings Server fixture target is missing');

mount(SettingsServerFixture, { target });
