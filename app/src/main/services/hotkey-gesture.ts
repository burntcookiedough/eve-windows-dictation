import type { Hotkey } from '../../shared/types.js';
import {
  isAltKeycode,
  isCtrlKeycode,
  isMetaKeycode,
  isModifierKey,
  isShiftKeycode,
} from './keycodes.js';

export const DOUBLE_TAP_WINDOW_MS = 450;
export const TAP_MAX_MS = 250;

export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface KeyEventSnapshot {
  keycode: number;
  modifiers: ModifierState;
  nowMs: number;
}

export type HotkeyGestureAction = 'hold-start' | 'hold-end' | 'double-tap';

interface ActivePress {
  keycode: number;
  modifierOnly: boolean;
  requiredModifiers: ModifierState;
  startedAtMs: number;
  kind: 'hold' | 'double-tap';
}

export class HotkeyGestureRecognizer {
  private activePress: ActivePress | null = null;
  private lastTapAtMs = 0;

  keyDown(event: KeyEventSnapshot, hotkey: Hotkey): HotkeyGestureAction | null {
    if (this.activePress || !matchesHotkeyDown(event, hotkey)) {
      return null;
    }

    const requiredModifiers = getRequiredModifiers(hotkey);
    const isDoubleTap =
      this.lastTapAtMs > 0 &&
      event.nowMs - this.lastTapAtMs <= DOUBLE_TAP_WINDOW_MS;

    this.activePress = {
      keycode: event.keycode,
      modifierOnly: isModifierKey(hotkey.keycode),
      requiredModifiers,
      startedAtMs: event.nowMs,
      kind: isDoubleTap ? 'double-tap' : 'hold',
    };

    if (isDoubleTap) {
      this.lastTapAtMs = 0;
      return 'double-tap';
    }

    return 'hold-start';
  }

  keyUp(event: KeyEventSnapshot): HotkeyGestureAction | null {
    if (!this.activePress || !matchesActiveRelease(event.keycode, this.activePress)) {
      return null;
    }

    const activePress = this.activePress;
    this.activePress = null;

    if (activePress.kind === 'double-tap') {
      this.lastTapAtMs = 0;
      return null;
    }

    const pressDurationMs = event.nowMs - activePress.startedAtMs;
    this.lastTapAtMs = pressDurationMs <= TAP_MAX_MS ? event.nowMs : 0;
    return 'hold-end';
  }

  reset(): void {
    this.activePress = null;
    this.lastTapAtMs = 0;
  }
}

export function matchesHotkeyDown(event: KeyEventSnapshot, hotkey: Hotkey): boolean {
  const modifierOnlyHotkey = isModifierKey(hotkey.keycode);
  const requiredModifiers = getRequiredModifiers(hotkey);

  if (modifierOnlyHotkey) {
    return (
      isRequiredModifierEvent(event.keycode, requiredModifiers) &&
      modifiersExactlyMatch(event.modifiers, requiredModifiers)
    );
  }

  return (
    event.keycode === hotkey.keycode &&
    event.modifiers.ctrl === hotkey.ctrlKey &&
    event.modifiers.alt === hotkey.altKey &&
    event.modifiers.shift === hotkey.shiftKey &&
    event.modifiers.meta === hotkey.metaKey
  );
}

export function captureModifierChord(event: KeyEventSnapshot): Hotkey | null {
  if (!isMetaKeycode(event.keycode)) {
    return null;
  }

  const hasCompanionModifier =
    event.modifiers.ctrl || event.modifiers.alt || event.modifiers.shift;
  if (!hasCompanionModifier) {
    return null;
  }

  return {
    keycode: event.keycode,
    ctrlKey: event.modifiers.ctrl,
    altKey: event.modifiers.alt,
    shiftKey: event.modifiers.shift,
    metaKey: false,
  };
}

export function getRequiredModifiers(hotkey: Hotkey): ModifierState {
  return {
    ctrl: hotkey.ctrlKey || isCtrlKeycode(hotkey.keycode),
    alt: hotkey.altKey || isAltKeycode(hotkey.keycode),
    shift: hotkey.shiftKey || isShiftKeycode(hotkey.keycode),
    meta: hotkey.metaKey || isMetaKeycode(hotkey.keycode),
  };
}

function modifiersExactlyMatch(actual: ModifierState, expected: ModifierState): boolean {
  return (
    actual.ctrl === expected.ctrl &&
    actual.alt === expected.alt &&
    actual.shift === expected.shift &&
    actual.meta === expected.meta
  );
}

function isRequiredModifierEvent(keycode: number, requiredModifiers: ModifierState): boolean {
  return (
    (requiredModifiers.ctrl && isCtrlKeycode(keycode)) ||
    (requiredModifiers.alt && isAltKeycode(keycode)) ||
    (requiredModifiers.shift && isShiftKeycode(keycode)) ||
    (requiredModifiers.meta && isMetaKeycode(keycode))
  );
}

function matchesActiveRelease(keycode: number, activePress: ActivePress): boolean {
  if (!activePress.modifierOnly) {
    return keycode === activePress.keycode;
  }

  return isRequiredModifierEvent(keycode, activePress.requiredModifiers);
}
