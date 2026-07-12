import { uIOhook } from 'uiohook-napi';
import type { UiohookKeyboardEvent } from 'uiohook-napi';
import { app } from 'electron';
import type { Hotkey } from '../../shared/types.js';
import { getSetting } from './settings.js';
import {
  formatHotkey,
  isAltKeycode,
  isCtrlKeycode,
  isMetaKeycode,
  isModifierKey,
  isShiftKeycode,
} from './keycodes.js';
import { HotkeyGestureRecognizer } from './hotkey-gesture.js';
import { captureModifierChord } from './hotkey-gesture.js';
import type { KeyEventSnapshot, ModifierState } from './hotkey-gesture.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Hotkey');

interface HotkeyCallbacks {
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onDoubleTap: () => void;
  onLongShortcut: () => void;
}

let callbacks: HotkeyCallbacks | null = null;
let isStarted = false;
let heldCtrl = false;
let heldAlt = false;
let heldShift = false;
let heldMeta = false;
const quickRecognizer = new HotkeyGestureRecognizer();
const longRecognizer = new HotkeyGestureRecognizer();

// Current hotkey configuration (read from settings on each key event)
function getCurrentHotkey(): Hotkey {
  return getSetting('hotkey');
}

function getCurrentLongHotkey(): Hotkey {
  return getSetting('longHotkey');
}

function updateHeldModifiers(e: UiohookKeyboardEvent, isDown: boolean): void {
  if (isCtrlKeycode(e.keycode)) heldCtrl = isDown;
  if (isAltKeycode(e.keycode)) heldAlt = isDown;
  if (isShiftKeycode(e.keycode)) heldShift = isDown;
  if (isMetaKeycode(e.keycode)) heldMeta = isDown;
}

function currentModifiers(e: UiohookKeyboardEvent): ModifierState {
  return {
    ctrl: heldCtrl || e.ctrlKey,
    alt: heldAlt || e.altKey,
    shift: heldShift || e.shiftKey,
    meta: heldMeta || e.metaKey,
  };
}

function heldModifiers(): ModifierState {
  return {
    ctrl: heldCtrl,
    alt: heldAlt,
    shift: heldShift,
    meta: heldMeta,
  };
}

function eventSnapshot(e: UiohookKeyboardEvent): KeyEventSnapshot {
  return {
    keycode: e.keycode,
    modifiers: currentModifiers(e),
    nowMs: Date.now(),
  };
}

function keyUpSnapshot(e: UiohookKeyboardEvent): KeyEventSnapshot {
  return {
    keycode: e.keycode,
    modifiers: heldModifiers(),
    nowMs: Date.now(),
  };
}

export function setupHotkeyService(hotkeyCallbacks: HotkeyCallbacks): void {
  callbacks = hotkeyCallbacks;

  uIOhook.on('keydown', (e) => {
    updateHeldModifiers(e, true);
    const snapshot = eventSnapshot(e);
    const longAction = longRecognizer.keyDown(snapshot, getCurrentLongHotkey());
    if (longAction === 'hold-start' || longAction === 'double-tap') {
      quickRecognizer.reset();
      log.debug('Long hotkey', { keycode: e.keycode });
      callbacks?.onLongShortcut();
      return;
    }

    const action = quickRecognizer.keyDown(snapshot, getCurrentHotkey());
    if (action === 'hold-start') {
      log.debug('Hotkey hold start', { keycode: e.keycode });
      callbacks?.onHoldStart();
    } else if (action === 'double-tap') {
      log.debug('Hotkey double tap', { keycode: e.keycode });
      callbacks?.onDoubleTap();
    }
  });

  uIOhook.on('keyup', (e) => {
    updateHeldModifiers(e, false);
    const snapshot = keyUpSnapshot(e);
    longRecognizer.keyUp(snapshot);
    const action = quickRecognizer.keyUp(snapshot);
    if (action === 'hold-end') {
      log.debug('Hotkey hold end', { keycode: e.keycode });
      callbacks?.onHoldEnd();
    }
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
  quickRecognizer.reset();
  longRecognizer.reset();
  heldCtrl = false;
  heldAlt = false;
  heldShift = false;
  heldMeta = false;
}

// --- Hotkey Capture ---

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
      if (isModifierKey(e.keycode)) {
        const modifierHotkey = captureModifierChord(eventSnapshot(e));
        if (!modifierHotkey) {
          return;
        }

        resolveCapturedHotkey(modifierHotkey, resolve);
        return;
      }

      const hotkey: Hotkey = {
        keycode: e.keycode,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
      };

      resolveCapturedHotkey(hotkey, resolve);
    };

    uIOhook.on('keydown', captureListener);
  });
}

function resolveCapturedHotkey(
  hotkey: Hotkey,
  resolve: (value: { hotkey: Hotkey; displayName: string }) => void,
): void {
  const displayName = formatHotkey(hotkey);

  if (captureListener) {
    uIOhook.off('keydown', captureListener);
    captureListener = null;
  }

  resetKeyState();
  resolve({ hotkey, displayName });
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
