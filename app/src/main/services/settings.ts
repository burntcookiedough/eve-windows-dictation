import Store from 'electron-store';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types.js';

const store = new Store<Settings>({
  name: 'settings',
  defaults: DEFAULT_SETTINGS,
});

export function getSettings(): Settings {
  // Return all settings, falling back to defaults for any missing keys
  return {
    hotkey: store.get('hotkey'),
    holdToTalk: store.get('holdToTalk'),
    autoCopy: store.get('autoCopy'),
    autoPaste: store.get('autoPaste'),
    silenceTimeout: store.get('silenceTimeout'),
    serverUrl: store.get('serverUrl'),
    theme: store.get('theme'),
    appendPeriod: store.get('appendPeriod'),
    appendSpace: store.get('appendSpace'),
  };
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return store.get(key);
}

export function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  store.set(key, value);
}

export function updateSettings(settings: Partial<Settings>): void {
  for (const [key, value] of Object.entries(settings)) {
    store.set(key as keyof Settings, value);
  }
}
