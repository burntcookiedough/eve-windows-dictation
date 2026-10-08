import { mount } from 'svelte';
import { DEFAULT_SETTINGS, type GpuPackState } from '$shared/types';
import SettingsView from '../views/SettingsView.svelte';
import { serverStatusState } from '../server-status';
import '../app.css';

// This fixture mounts the production Settings view with isolated, synthetic IPC.
const packId = 'a'.repeat(64);
const calls: string[] = [];
const listeners = new Set<(state: GpuPackState) => void>();
let state: GpuPackState = { status: 'ready', packId, restartRequired: true };
let complete: (() => void) | null = null;
function publish(next: GpuPackState) {
  state = next;
  for (const listener of listeners) listener(next);
}
function repair() {
  calls.push('repair');
  publish({ status: 'validating', packId });
  return new Promise<GpuPackState>((resolve) => {
    complete = () => {
      publish({ status: 'ready', packId, restartRequired: true });
      resolve(state);
      complete = null;
    };
  });
}
const api = {
  getSettings: async () => structuredClone(DEFAULT_SETTINGS),
  getAppVersion: async () => 'fixture',
  getHotkeyDisplayName: async () => 'Ctrl+Win',
  getServerSettings: async () => { throw new Error('Synthetic offline server'); },
  getServerLogs: async () => [],
  getGpuPackState: async () => state,
  onGpuPackStateChange: (listener: (state: GpuPackState) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  repairGpuPack: repair,
  installGpuPack: async () => { calls.push('install'); return state; },
  removeGpuPack: async () => {
    calls.push('remove');
    publish({ status: 'missing', packId, downloadBytes: 100 });
    return state;
  },
  updateSetting: async () => { calls.push('updateSetting'); },
};
window.murmurMain = new Proxy(api, {
  get(target, key) {
    if (key in target) return target[key as keyof typeof target];
    if (String(key).startsWith('on')) return () => () => {};
    return async () => null;
  },
}) as unknown as Window['murmurMain'];
Object.defineProperty(navigator, 'mediaDevices', { value: {
  getUserMedia: async () => ({ getTracks: () => [] }),
  enumerateDevices: async () => [],
} });
Object.assign(window, { gpuFixture: {
  calls,
  publish,
  finish: () => complete?.(),
  cpuFallback: () => serverStatusState.set({ phase: 'ready', announcement: '', state: {
    status: 'running', managed: false,
    runtime: { app_build: 'fixture', server_build: 'fixture', pack_id: packId, effective_device: 'cpu' },
  } }),
  deviceUnknown: () => serverStatusState.set({ phase: 'ready', announcement: '', state: {
    status: 'running', managed: false,
    runtime: { app_build: 'fixture', server_build: 'fixture', pack_id: packId, effective_device: null },
  } }),
} });
const target = document.querySelector('#fixture-root');
if (!target) throw new Error('GPU fixture root missing');
mount(SettingsView, { target });
