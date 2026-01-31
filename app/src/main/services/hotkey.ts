import { uIOhook, UiohookKey } from 'uiohook-napi';
import { app } from 'electron';

let keyDownCallback: (() => void) | null = null;
let keyUpCallback: (() => void) | null = null;
let isKeyDown = false;
let isStarted = false;

// F17 key code - UiohookKey.F17 = 0xFFCE (65486) for X11, 128 for Windows
const F17_KEYCODE = 128; // Windows virtual key code for F17

export function setupHotkeyService(
  _accelerator: string, // Ignored - we hardcode F17
  onKeyDown: () => void,
  onKeyUp: () => void
): void {
  keyDownCallback = onKeyDown;
  keyUpCallback = onKeyUp;

  uIOhook.on('keydown', (e) => {
    // Check if it's F17 (keycode 128 on Windows)
    if (e.keycode === F17_KEYCODE || e.keycode === UiohookKey.F17) {
      if (!isKeyDown) {
        isKeyDown = true;
        console.log(`[${timestamp()}] F17 keydown`);
        keyDownCallback?.();
      }
    }
  });

  uIOhook.on('keyup', (e) => {
    if (e.keycode === F17_KEYCODE || e.keycode === UiohookKey.F17) {
      if (isKeyDown) {
        isKeyDown = false;
        console.log(`[${timestamp()}] F17 keyup`);
        keyUpCallback?.();
      }
    }
  });

  // Start the hook
  uIOhook.start();
  isStarted = true;
  console.log(`[${timestamp()}] Global keyboard hook started (listening for F17)`);

  // Clean up on app quit
  app.on('will-quit', () => {
    unregisterHotkey();
  });
}

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export function unregisterHotkey(): void {
  if (isStarted) {
    uIOhook.stop();
    isStarted = false;
    console.log(`[${timestamp()}] Global keyboard hook stopped`);
  }
}
