import Store from 'electron-store';
import { DEFAULT_SETTINGS, type Settings, type Hotkey, type WindowBounds } from '../../shared/types.js';

// Separate store for internal app state (not user-facing settings)
const internalStore = new Store<{ mainWindowBounds?: WindowBounds }>({
  name: 'internal',
});

const store = new Store<Settings>({
  name: 'settings',
  defaults: DEFAULT_SETTINGS,
  migrations: {
    // Migrate from string hotkey to object hotkey
    '1.0.0': (store) => {
      const hotkey = store.get('hotkey');
      if (typeof hotkey === 'string') {
        // Reset to default if old string format
        store.set('hotkey', DEFAULT_SETTINGS.hotkey);
      }
    },
  },
});

/**
 * Validate that a hotkey object has the correct shape
 */
function isValidHotkey(hotkey: unknown): hotkey is Hotkey {
  return (
    typeof hotkey === 'object' &&
    hotkey !== null &&
    typeof (hotkey as Hotkey).keycode === 'number' &&
    typeof (hotkey as Hotkey).ctrlKey === 'boolean' &&
    typeof (hotkey as Hotkey).altKey === 'boolean' &&
    typeof (hotkey as Hotkey).shiftKey === 'boolean' &&
    typeof (hotkey as Hotkey).metaKey === 'boolean'
  );
}

export function getSettings(): Settings {
  // Get hotkey with validation (handles migration from old string format)
  const storedHotkey = store.get('hotkey');
  const hotkey = isValidHotkey(storedHotkey) ? storedHotkey : DEFAULT_SETTINGS.hotkey;

  // Return all settings, falling back to defaults for any missing keys
  return {
    hotkey,
    holdToTalk: store.get('holdToTalk'),
    autoCopy: store.get('autoCopy'),
    autoPaste: store.get('autoPaste'),
    silenceTimeout: store.get('silenceTimeout'),
    serverUrl: store.get('serverUrl'),
    appendPeriod: store.get('appendPeriod'),
    appendSpace: store.get('appendSpace'),
    selectedDeviceId: store.get('selectedDeviceId'),
    launchOnBoot: store.get('launchOnBoot'),
    startMinimized: store.get('startMinimized'),
    serverAutoStart: store.get('serverAutoStart'),
  };
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  if (key === 'hotkey') {
    const storedHotkey = store.get('hotkey');
    return (isValidHotkey(storedHotkey) ? storedHotkey : DEFAULT_SETTINGS.hotkey) as Settings[K];
  }
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

// Window bounds persistence (internal, not user-facing)
export function getMainWindowBounds(): WindowBounds | undefined {
  return internalStore.get('mainWindowBounds');
}

export function setMainWindowBounds(bounds: WindowBounds): void {
  internalStore.set('mainWindowBounds', bounds);
}
