import { describe, expect, test } from 'bun:test';
import type { Hotkey } from '../src/shared/types.js';
import {
  captureModifierChord,
  HotkeyGestureRecognizer,
} from '../src/main/services/hotkey-gesture.js';
import type { ModifierState } from '../src/main/services/hotkey-gesture.js';

const KEY = {
  Ctrl: 29,
  Meta: 3675,
  Shift: 42,
  F17: 100,
};

const NONE: ModifierState = {
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

const CTRL_WIN: Hotkey = {
  keycode: KEY.Meta,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
};

const CTRL_SHIFT_WIN: Hotkey = {
  keycode: KEY.Meta,
  ctrlKey: true,
  altKey: false,
  shiftKey: true,
  metaKey: false,
};

const F17: Hotkey = {
  keycode: KEY.F17,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
};

function event(keycode: number, modifiers: Partial<ModifierState>, nowMs: number) {
  return {
    keycode,
    modifiers: { ...NONE, ...modifiers },
    nowMs,
  };
}

describe('HotkeyGestureRecognizer', () => {
  test('does not fire Ctrl+Win when only Ctrl is held', () => {
    const recognizer = new HotkeyGestureRecognizer();

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 0), CTRL_WIN)).toBeNull();
  });

  test('fires Ctrl+Win once both modifiers are down, regardless of order', () => {
    const ctrlThenWin = new HotkeyGestureRecognizer();
    expect(ctrlThenWin.keyDown(event(KEY.Ctrl, { ctrl: true }, 0), CTRL_WIN)).toBeNull();
    expect(ctrlThenWin.keyDown(event(KEY.Meta, { ctrl: true, meta: true }, 10), CTRL_WIN)).toBe('hold-start');

    const winThenCtrl = new HotkeyGestureRecognizer();
    expect(winThenCtrl.keyDown(event(KEY.Meta, { meta: true }, 0), CTRL_WIN)).toBeNull();
    expect(winThenCtrl.keyDown(event(KEY.Ctrl, { ctrl: true, meta: true }, 10), CTRL_WIN)).toBe('hold-start');
  });

  test('stops Ctrl+Win hold only after all required modifiers are released', () => {
    const recognizer = new HotkeyGestureRecognizer();

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 0), CTRL_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Meta, { ctrl: true, meta: true }, 10), CTRL_WIN)).toBe('hold-start');
    expect(recognizer.keyUp(event(KEY.Ctrl, { meta: true }, 100))).toBeNull();
    expect(recognizer.keyUp(event(KEY.Meta, {}, 110))).toBe('hold-end');
  });

  test('stops Ctrl+Win hold only after all required modifiers are released in reverse order', () => {
    const recognizer = new HotkeyGestureRecognizer();

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 0), CTRL_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Meta, { ctrl: true, meta: true }, 10), CTRL_WIN)).toBe('hold-start');
    expect(recognizer.keyUp(event(KEY.Meta, { ctrl: true }, 100))).toBeNull();
    expect(recognizer.keyUp(event(KEY.Ctrl, {}, 110))).toBe('hold-end');
  });

  test('does not fire modifier-only hotkey when an extra modifier is down', () => {
    const recognizer = new HotkeyGestureRecognizer();

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 0), CTRL_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Shift, { ctrl: true, shift: true }, 5), CTRL_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Meta, { ctrl: true, shift: true, meta: true }, 10), CTRL_WIN)).toBeNull();
  });

  test('double tap only fires after a completed quick tap', () => {
    const recognizer = new HotkeyGestureRecognizer();

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 0), CTRL_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Meta, { ctrl: true, meta: true }, 20), CTRL_WIN)).toBe('hold-start');
    expect(recognizer.keyUp(event(KEY.Meta, { ctrl: true }, 80))).toBeNull();
    expect(recognizer.keyUp(event(KEY.Ctrl, {}, 90))).toBe('hold-end');

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 200), CTRL_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Meta, { ctrl: true, meta: true }, 220), CTRL_WIN)).toBe('double-tap');
    expect(recognizer.keyUp(event(KEY.Meta, { ctrl: true }, 260))).toBeNull();
    expect(recognizer.keyUp(event(KEY.Ctrl, {}, 270))).toBeNull();
  });

  test('long hold is not treated as a double tap', () => {
    const recognizer = new HotkeyGestureRecognizer();

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 0), CTRL_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Meta, { ctrl: true, meta: true }, 20), CTRL_WIN)).toBe('hold-start');
    expect(recognizer.keyUp(event(KEY.Meta, { ctrl: true }, 400))).toBeNull();
    expect(recognizer.keyUp(event(KEY.Ctrl, {}, 410))).toBe('hold-end');

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 500), CTRL_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Meta, { ctrl: true, meta: true }, 520), CTRL_WIN)).toBe('hold-start');
  });

  test('non-modifier hotkey still fires immediately on exact key match', () => {
    const recognizer = new HotkeyGestureRecognizer();

    expect(recognizer.keyDown(event(KEY.F17, {}, 0), F17)).toBe('hold-start');
    expect(recognizer.keyUp(event(KEY.F17, {}, 40))).toBe('hold-end');
  });

  test('Ctrl+Shift+Win long chord requires all three modifiers', () => {
    const recognizer = new HotkeyGestureRecognizer();

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 0), CTRL_SHIFT_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Shift, { ctrl: true, shift: true }, 10), CTRL_SHIFT_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Meta, { ctrl: true, shift: true, meta: true }, 20), CTRL_SHIFT_WIN)).toBe('hold-start');
  });

  test('Ctrl+Shift+Win long chord ends only after all required modifiers are released', () => {
    const recognizer = new HotkeyGestureRecognizer();

    expect(recognizer.keyDown(event(KEY.Ctrl, { ctrl: true }, 0), CTRL_SHIFT_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Shift, { ctrl: true, shift: true }, 10), CTRL_SHIFT_WIN)).toBeNull();
    expect(recognizer.keyDown(event(KEY.Meta, { ctrl: true, shift: true, meta: true }, 20), CTRL_SHIFT_WIN)).toBe('hold-start');
    expect(recognizer.keyUp(event(KEY.Meta, { ctrl: true, shift: true }, 100))).toBeNull();
    expect(recognizer.keyUp(event(KEY.Shift, { ctrl: true }, 110))).toBeNull();
    expect(recognizer.keyUp(event(KEY.Ctrl, {}, 120))).toBe('hold-end');
  });

  test('captures Windows-key modifier chords only when Meta is the final modifier', () => {
    expect(captureModifierChord(event(KEY.Ctrl, { ctrl: true }, 0))).toBeNull();
    expect(captureModifierChord(event(KEY.Shift, { ctrl: true, shift: true }, 10))).toBeNull();

    expect(captureModifierChord(event(KEY.Meta, { ctrl: true, meta: true }, 20))).toEqual({
      keycode: KEY.Meta,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    });
    expect(captureModifierChord(event(KEY.Meta, { ctrl: true, shift: true, meta: true }, 30))).toEqual({
      keycode: KEY.Meta,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    });
  });
});
