import { describe, expect, test } from 'bun:test';
import { formatHotkeyForPlatform } from '../src/main/services/keycodes';
import { DEFAULT_SETTINGS } from '$shared/types';

describe('hotkey display labels', () => {
  const ctrlWin = {
    keycode: 3675,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  };

  test('calls the Windows key Win without changing stored Meta keycode semantics', () => {
    expect(formatHotkeyForPlatform(ctrlWin, 'win32')).toBe('Ctrl+Win');
    expect(formatHotkeyForPlatform({ ...ctrlWin, shiftKey: true }, 'win32')).toBe('Ctrl+Shift+Win');
    expect(formatHotkeyForPlatform(ctrlWin, 'darwin')).toBe('Ctrl+Meta');
    expect(DEFAULT_SETTINGS.hotkey).toMatchObject({ keycode: 3675, ctrlKey: true, metaKey: false });
    expect(DEFAULT_SETTINGS.longHotkey).toMatchObject({ keycode: 3675, ctrlKey: true, shiftKey: true, metaKey: false });
  });
});
