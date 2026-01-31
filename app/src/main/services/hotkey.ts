import { globalShortcut, app } from 'electron';

let currentAccelerator: string | null = null;
let isKeyDown = false;
let keyDownCallback: (() => void) | null = null;
let keyUpCallback: (() => void) | null = null;

// Polling interval for key state (electron doesn't have native keyup for global shortcuts)
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function setupHotkeyService(
  accelerator: string,
  onKeyDown: () => void,
  onKeyUp: () => void
): void {
  currentAccelerator = accelerator;
  keyDownCallback = onKeyDown;
  keyUpCallback = onKeyUp;

  // Register the global shortcut
  const registered = globalShortcut.register(accelerator, () => {
    if (!isKeyDown) {
      isKeyDown = true;
      keyDownCallback?.();
      startPollingForKeyUp();
    }
  });

  if (!registered) {
    console.error(`Failed to register global shortcut: ${accelerator}`);
  } else {
    console.log(`Global shortcut registered: ${accelerator}`);
  }

  // Clean up on app quit
  app.on('will-quit', () => {
    unregisterHotkey();
  });
}

function startPollingForKeyUp(): void {
  if (pollInterval) return;

  // Poll for key release
  // This is a workaround since Electron doesn't support keyup for global shortcuts
  // We check if the shortcut fires again within the interval
  let lastTriggerTime = Date.now();

  pollInterval = setInterval(() => {
    const now = Date.now();
    // If we haven't received a trigger in 150ms, assume key is released
    if (now - lastTriggerTime > 150 && isKeyDown) {
      isKeyDown = false;
      keyUpCallback?.();
      stopPolling();
    }
  }, 50);

  // Update last trigger time on each shortcut press
  if (currentAccelerator) {
    globalShortcut.unregister(currentAccelerator);
    globalShortcut.register(currentAccelerator, () => {
      lastTriggerTime = Date.now();
      if (!isKeyDown) {
        isKeyDown = true;
        keyDownCallback?.();
      }
    });
  }
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

export function unregisterHotkey(): void {
  stopPolling();
  if (currentAccelerator) {
    globalShortcut.unregister(currentAccelerator);
    currentAccelerator = null;
  }
}
