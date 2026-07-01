import { UiohookKey } from 'uiohook-napi';
import type { Hotkey } from '../../shared/types.js';

// Build reverse lookup: keycode number → key name string
const keycodeToName = new Map<number, string>(
  Object.entries(UiohookKey)
    .filter(([key]) => isNaN(Number(key))) // Filter out reverse enum entries
    .map(([name, code]) => [code as number, name])
);

// Modifier keycodes to filter out during recording
const MODIFIER_KEYCODES = new Set<number>([
  UiohookKey.Ctrl,
  UiohookKey.CtrlRight,
  UiohookKey.Alt,
  UiohookKey.AltRight,
  UiohookKey.Shift,
  UiohookKey.ShiftRight,
  UiohookKey.Meta,
  UiohookKey.MetaRight,
]);

/**
 * Check if a keycode is a modifier key (Ctrl, Alt, Shift, Meta)
 */
export function isModifierKey(keycode: number): boolean {
  return MODIFIER_KEYCODES.has(keycode);
}

export function isMetaKeycode(keycode: number): boolean {
  return keycode === UiohookKey.Meta || keycode === UiohookKey.MetaRight;
}

export function isCtrlKeycode(keycode: number): boolean {
  return keycode === UiohookKey.Ctrl || keycode === UiohookKey.CtrlRight;
}

export function isAltKeycode(keycode: number): boolean {
  return keycode === UiohookKey.Alt || keycode === UiohookKey.AltRight;
}

export function isShiftKeycode(keycode: number): boolean {
  return keycode === UiohookKey.Shift || keycode === UiohookKey.ShiftRight;
}

/**
 * Get human-readable name for a keycode
 */
export function getKeyName(keycode: number): string {
  return keycodeToName.get(keycode) ?? `Key${keycode}`;
}

/**
 * Format a hotkey configuration as a human-readable string
 * e.g., "Ctrl+Shift+F17" or just "F17"
 */
export function formatHotkey(hotkey: Hotkey): string {
  const parts: string[] = [];

  if (hotkey.ctrlKey) parts.push('Ctrl');
  if (hotkey.altKey) parts.push('Alt');
  if (hotkey.shiftKey) parts.push('Shift');
  if (hotkey.metaKey) parts.push('Meta');

  const keyName = getKeyName(hotkey.keycode);
  parts.push(keyName);

  return parts.join('+');
}
