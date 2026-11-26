import { describe, expect, mock, test } from 'bun:test';

type KeyboardEvent = {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

type KeyboardListener = (event: KeyboardEvent) => void;

const listeners = new Set<KeyboardListener>();
const keyUpListeners = new Set<KeyboardListener>();
const uIOhook = {
  on: mock((event: string, listener: KeyboardListener) => {
    (event === 'keyup' ? keyUpListeners : listeners).add(listener);
  }),
  off: mock((_event: string, listener: KeyboardListener) => {
    listeners.delete(listener);
  }),
  start: mock(() => undefined),
  stop: mock(() => undefined),
};

mock.module('electron', () => ({
  app: {
    on: mock(() => undefined),
  },
}));

mock.module('uiohook-napi', () => ({
  uIOhook,
  UiohookKey: {
    Ctrl: 29,
    CtrlRight: 3613,
    Alt: 56,
    AltRight: 3640,
    Shift: 42,
    ShiftRight: 54,
    Meta: 3675,
    MetaRight: 3676,
    F17: 100,
  },
}));

mock.module('../src/main/services/settings.js', () => ({
  getSetting: (key: string) => ({
    keycode: 3675,
    ctrlKey: true,
    altKey: false,
    shiftKey: key === 'longHotkey',
    metaKey: false,
  }),
}));

const { cancelHotkeyCapture, setupHotkeyService, startHotkeyCapture, unregisterHotkey } = await import('../src/main/services/hotkey.js');

const keyEvent = (keycode: number): KeyboardEvent => ({
  keycode,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
});

test('a tap rejected during delivery cannot seed Long or release Quick', () => {
  let finalizing = true;
  const events: string[] = [];
  setupHotkeyService({
    onHoldStart: () => {
      events.push(finalizing ? 'busy' : 'quick');
      return !finalizing;
    },
    onHoldEnd: () => { events.push('release'); },
    onDoubleTap: () => { events.push('long'); return true; },
    onLongShortcut: () => { events.push('long shortcut'); return true; },
  });
  const down = (code: number) => listeners.forEach(listener => listener(keyEvent(code)));
  const up = (code: number) => keyUpListeners.forEach(listener => listener(keyEvent(code)));
  try {
    down(29);
    down(3675);
    finalizing = false;
    down(3675); // Auto-repeat while the rejected press is still held.
    up(3675);
    up(29);
    down(29);
    down(3675);
    expect(events).toEqual(['busy', 'quick']);
  } finally {
    up(3675);
    up(29);
    unregisterHotkey();
    listeners.clear();
    keyUpListeners.clear();
  }
});

describe('hotkey capture lifecycle', () => {
  test('cancellation settles the pending invocation and detaches its listener', async () => {
    const pending = startHotkeyCapture();

    cancelHotkeyCapture();

    await expect(pending).rejects.toMatchObject({
      message: 'Hotkey capture cancelled',
    });
    expect(listeners.size).toBe(0);
  });

  test('replacement settles the old invocation and ignores its stale callback', async () => {
    const first = startHotkeyCapture();
    const staleListener = [...listeners][0];
    expect(staleListener).toBeDefined();

    const second = startHotkeyCapture();
    const currentListener = [...listeners][0];
    expect(currentListener).toBeDefined();
    expect(currentListener).not.toBe(staleListener);

    await expect(first).rejects.toMatchObject({
      message: 'Hotkey capture replaced',
    });

    staleListener?.(keyEvent(100));
    expect(listeners).toContain(currentListener);

    currentListener?.(keyEvent(100));
    await expect(second).resolves.toMatchObject({
      hotkey: {
        keycode: 100,
      },
    });
    expect(listeners.size).toBe(0);
  });
});
