import { uIOhook } from 'uiohook-napi';
import type { UiohookKeyboardEvent } from 'uiohook-napi';
import { app } from 'electron';
import type { Hotkey } from '../../shared/types.js';
import { getSetting } from './settings.js';
import { isModifierKey, formatHotkey } from './keycodes.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Hotkey');

let keyDownCallback: (() => void) | null = null;
let keyUpCallback: (() => void) | null = null;
let isKeyDown = false;
let isStarted = false;
let activeKeycode: number | null = null; // Track which keycode triggered the keydown
let heldCtrl = false;
let heldAlt = false;
let heldShift = false;
let heldMeta = false;

// Current hotkey configuration (read from settings on each key event)
function getCurrentHotkey(): Hotkey {
  return getSetting('hotkey');
}

function isMetaKeycode(keycode: number): boolean {
  return keycode === 3675 || keycode === 3676;
}

function isCtrlKeycode(keycode: number): boolean {
  return keycode === 29 || keycode === 3613;
}

function isAltKeycode(keycode: number): boolean {
  return keycode === 56 || keycode === 3640;
}

function isShiftKeycode(keycode: number): boolean {
  return keycode === 42 || keycode === 54;
}

function updateHeldModifiers(e: UiohookKeyboardEvent, isDown: boolean): void {
  if (isCtrlKeycode(e.keycode)) heldCtrl = isDown;
  if (isAltKeycode(e.keycode)) heldAlt = isDown;
  if (isShiftKeycode(e.keycode)) heldShift = isDown;
  if (isMetaKeycode(e.keycode)) heldMeta = isDown;
}

/**
 * Check if a keyboard event matches the configured hotkey (full match including modifiers)
 */
function matchesHotkeyDown(e: UiohookKeyboardEvent, hotkey: Hotkey): boolean {
  const metaTrigger = isMetaKeycode(hotkey.keycode);
  const ctrlTrigger = isCtrlKeycode(hotkey.keycode);
  const keyMatches = metaTrigger ? isMetaKeycode(e.keycode) : e.keycode === hotkey.keycode;
  const effectiveCtrl = e.ctrlKey || heldCtrl || ctrlTrigger;
  const effectiveAlt = e.altKey || heldAlt || isAltKeycode(e.keycode);
  const effectiveShift = e.shiftKey || heldShift || isShiftKeycode(e.keycode);
  const effectiveMeta = e.metaKey || heldMeta || metaTrigger;
  const ctrlMatches = ctrlTrigger ? true : effectiveCtrl === hotkey.ctrlKey;
  const metaMatches = metaTrigger ? true : effectiveMeta === hotkey.metaKey;

  return (
    keyMatches &&
    ctrlMatches &&
    effectiveAlt === hotkey.altKey &&
    effectiveShift === hotkey.shiftKey &&
    metaMatches
  );
}

/**
 * Check if a keyboard event matches the keyup for the active hotkey.
 * Only checks keycode, not modifiers, since user may release modifiers before main key.
 */
function matchesHotkeyUp(e: UiohookKeyboardEvent): boolean {
  return (
    activeKeycode !== null &&
    (e.keycode === activeKeycode ||
      (isMetaKeycode(activeKeycode) && isMetaKeycode(e.keycode)))
  );
}

export function setupHotkeyService(
  onKeyDown: () => void,
  onKeyUp: () => void
): void {
  keyDownCallback = onKeyDown;
  keyUpCallback = onKeyUp;

  uIOhook.on('keydown', (e) => {
    updateHeldModifiers(e, true);
    const hotkey = getCurrentHotkey();
    if (matchesHotkeyDown(e, hotkey)) {
      if (!isKeyDown) {
        isKeyDown = true;
        activeKeycode = e.keycode;
        log.debug('Keydown', { keycode: e.keycode });
        keyDownCallback?.();
      }
    }
  });

  uIOhook.on('keyup', (e) => {
    if (matchesHotkeyUp(e)) {
      if (isKeyDown) {
        isKeyDown = false;
        activeKeycode = null;
        log.debug('Keyup', { keycode: e.keycode });
        keyUpCallback?.();
      }
    }
    updateHeldModifiers(e, false);
  });

  // Start the hook
  uIOhook.start();
  isStarted = true;
  const hotkey = getCurrentHotkey();
  log.info('Global keyboard hook started', { keycode: hotkey.keycode });

  // Clean up on app quit
  app.on('will-quit', () => {
    unregisterHotkey();
  });
}

export function unregisterHotkey(): void {
  if (isStarted) {
    uIOhook.stop();
    isStarted = false;
    log.info('Global keyboard hook stopped');
  }
}

/**
 * Reset the key state (useful when hotkey changes while key is held)
 */
export function resetKeyState(): void {
  isKeyDown = false;
  activeKeycode = null;
  heldCtrl = false;
  heldAlt = false;
  heldShift = false;
  heldMeta = false;
}

// --- Hotkey Capture ---

let captureCallback: ((hotkey: Hotkey, displayName: string) => void) | null = null;
let captureListener: ((e: UiohookKeyboardEvent) => void) | null = null;

/**
 * Start capturing a hotkey. The next non-modifier key press will be captured.
 * Returns a promise that resolves with the captured hotkey and its display name.
 */
export function startHotkeyCapture(): Promise<{ hotkey: Hotkey; displayName: string }> {
  return new Promise((resolve) => {
    // Remove any existing capture listener
    if (captureListener) {
      uIOhook.off('keydown', captureListener);
    }

    captureListener = (e: UiohookKeyboardEvent) => {
      // Ignore modifier-only key presses
      if (isModifierKey(e.keycode)) {
        return;
      }

      // Capture the hotkey
      const hotkey: Hotkey = {
        keycode: e.keycode,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
      };

      const displayName = formatHotkey(hotkey);

      // Clean up listener
      if (captureListener) {
        uIOhook.off('keydown', captureListener);
        captureListener = null;
      }

      // Reset key state in case the captured key is also the current hotkey
      resetKeyState();

      resolve({ hotkey, displayName });
    };

    uIOhook.on('keydown', captureListener);
  });
}

/**
 * Cancel an in-progress hotkey capture
 */
export function cancelHotkeyCapture(): void {
  if (captureListener) {
    uIOhook.off('keydown', captureListener);
    captureListener = null;
  }
}
