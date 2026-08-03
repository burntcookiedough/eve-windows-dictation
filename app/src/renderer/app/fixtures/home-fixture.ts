import '../app.css';
import { mount } from 'svelte';
import type { ServerStatePayload } from '$shared/types';
import HomeView from '../views/HomeView.svelte';
import { serverStatusState, type ServerStatusPhase } from '../server-status';

const params = new URLSearchParams(location.search);
const phase = (params.get('phase') ?? 'ready') as ServerStatusPhase;

const readyState: ServerStatePayload = {
  status: 'running',
  managed: true,
  port: 51717,
  engineStatus: {
    current: 'whisper',
    status: 'ready',
    info: {
      id: 'whisper',
      name: 'Faster-Whisper',
      model: 'large-v3-turbo',
      supports_hotwords: true,
      languages: ['en', 'de', 'fr', 'es', 'it', 'ja'],
      model_size_gb: 1.5,
      device: 'auto',
    },
  },
  modelDownload: { model: 'large-v3-turbo', size_gb: 1.5, status: 'ready', phase: 'ready', cached: true },
};

const state: ServerStatePayload | null = phase === 'ready'
  ? readyState
  : phase === 'downloading'
    ? {
        ...readyState,
        engineStatus: { current: 'whisper', status: 'loading' },
        modelDownload: {
          model: 'large-v3',
          size_gb: 2.9,
          status: 'downloading',
          phase: 'downloading',
          progress_percent: 48,
          downloaded_bytes: 1_400_000_000,
          total_bytes: 2_900_000_000,
        },
      }
    : phase === 'error'
      ? { status: 'error', managed: true, error: 'Fixture speech service unavailable.' }
      : null;

serverStatusState.set({
  state,
  phase,
  announcement: `Fixture ${phase}`,
  configuredExternalServer: false,
});

Object.assign(window, {
  murmurMain: {
    getSettings: async () => ({
      hotkey: { keycode: 3675, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
      longHotkey: { keycode: 3675, ctrlKey: true, altKey: false, shiftKey: true, metaKey: false },
    }),
    getHotkeyDisplayName: async (hotkey: { shiftKey: boolean }) => hotkey.shiftKey ? 'Ctrl+Shift+Win' : 'Ctrl+Win',
  },
});

mount(HomeView, {
  target: document.getElementById('fixture-root')!,
  props: { onNavigate: () => {} },
});
