# Electron overlay UI on Windows: a practical guide

This is **not** a build checklist or file-by-file guide. It's a reference document with resources, explanations, and patterns for building overlay-style UIs in Electron — the kind used by voice transcription tools, screen annotation apps, and similar "system-level" utilities.

**Important caveats:**

- **Do your own research.** This document is a starting point, not gospel. Electron evolves, APIs change, and edge cases vary by OS version, GPU, and configuration. Verify everything you plan to use against current documentation.
- **This covers UI only.** A real application will have significant complexity beyond what's covered here: audio capture, speech recognition, text injection, backend communication, installers, auto-update, etc. This document focuses narrowly on the Electron window/UI layer.
- **Test on real hardware.** Overlay behavior varies significantly across Windows 10 vs 11, different GPU vendors, DPI configurations, and multi-monitor setups. What works in development may behave differently in production.

---

## 1) Mental model: what you're building

An overlay UI is usually **multiple windows with different responsibilities**, not "one window that does everything":

* **Background/tray process** (always running): lifecycle, hotkeys, mic state, IPC routing.
* **Overlay window (pill/bar)**: tiny, transient, high-frequency updates (recording/processing).
* **Popover / expanded panel** (optional): richer UI (review transcript, modes, settings).

This separation is how you keep the overlay **fast** and **stable**: you avoid heavy UI re-layout work in the overlay window and keep it "hot" (pre-created, hidden, then shown instantly).

---

## 2) Window style decisions that matter on Windows

### Frameless + transparent: the "overlay look"

Electron supports transparent, frameless windows. This is how you get a clean pill UI without native chrome.

Key `BrowserWindow` options:

```javascript
const overlayWindow = new BrowserWindow({
  frame: false,              // Remove window chrome
  transparent: true,         // Enable transparency (requires frame: false on Windows)
  resizable: false,          // Transparent windows + resizable can cause issues
  skipTaskbar: true,         // Don't show in taskbar
  alwaysOnTop: true,         // Stay above other windows
  focusable: false,          // Don't steal focus (see section below)
  
  // Optional but often useful:
  hasShadow: false,          // Remove shadow (macOS mainly)
  thickFrame: false,         // Windows: removes shadow + animations
  
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,  // Security: isolate preload from renderer
    nodeIntegration: false   // Security: don't expose Node in renderer
  }
});
```

Key implications:

* Transparent windows often interact with GPU/compositing in ways that can cause jank if you animate too much.
* Prefer simple transforms/opacity, avoid heavy blur effects unless you accept perf variability across GPUs.
* On Windows, `transparent: true` only works when `frame: false`.

**Reference:** [Electron Custom Window Styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)

### Always-on-top: "feels like OS UI"

Basic `alwaysOnTop: true` works for most cases. For more control, use `setAlwaysOnTop()` with level:

```javascript
// Basic
overlayWindow.setAlwaysOnTop(true);

// With level (macOS has more options)
overlayWindow.setAlwaysOnTop(true, 'screen-saver'); // Highest on macOS
overlayWindow.setVisibleOnAllWorkspaces(true);      // Show on all desktops
```

What to watch:

* Always-on-top is not absolute: some fullscreen modes and certain window classes can still cover you.
* If you need "over exclusive fullscreen games," Electron is usually the wrong approach (that's graphics-hook overlay territory).
* On macOS, use `app.dock.hide()` combined with `setAlwaysOnTop(true, 'screen-saver')` for maximum z-order.

**Reference:** [Electron BrowserWindow API](https://www.electronjs.org/docs/latest/api/browser-window)  
**Known issue:** [alwaysOnTop over fullscreen apps (GitHub #10078)](https://github.com/electron/electron/issues/10078)

### Focus & taskbar: don't steal focus

Overlay windows should generally avoid stealing focus (this is core to "OS layer" feel).

Key options:

```javascript
{
  focusable: false,    // Window cannot receive focus
  skipTaskbar: true    // Don't appear in taskbar (Windows auto-sets this when focusable: false)
}
```

Practical consequences:

* If the overlay is not focusable, you must plan for **non-mouse interaction** (hotkeys) or an alternate focused popover window.
* A lot of "overlay feels nice" comes from never interrupting the user's typing focus.

---

## 3) Click-through behavior: the real trapdoor

"Overlay that doesn't block clicks" is the #1 place teams burn time.

Electron does not offer a perfect, universally reliable "click-through transparency regions" abstraction for Windows. The core API is `setIgnoreMouseEvents()`:

```javascript
// Make entire window click-through
overlayWindow.setIgnoreMouseEvents(true);

// Click-through with mouse event forwarding (Windows only)
overlayWindow.setIgnoreMouseEvents(true, { forward: true });
```

**Reference:** [Electron Frameless Window docs](https://www.electronjs.org/docs/latest/api/frameless-window)  
**Known issues:**
- [Click-through frameless transparent window issues (GitHub #23042)](https://github.com/electron/electron/issues/23042)
- [Support click-through of transparency (GitHub #1335)](https://github.com/electron/electron/issues/1335)
- [setIgnoreMouseEvents forwarding issues (GitHub #33281)](https://github.com/electron/electron/issues/33281)

### Design patterns that avoid pain

**Pattern A: fully non-interactive overlay**

* Overlay never receives mouse events (`setIgnoreMouseEvents(true)` always).
* All interaction is via hotkeys / voice.
* This is the simplest and most reliable approach.

**Pattern B: interactive overlay, but only when "expanded"**

* Keep the always-present pill non-interactive.
* When the user needs to click something, open a *separate* focused popover window.
* Close popover quickly, return to fully non-interactive overlay.

This split avoids needing "partial click-through" in one window, which is the hardest variant to make robust.

### If you *must* do partial click-through

The `forward: true` option enables a workaround pattern:

```javascript
// In renderer, toggle click-through based on what's under cursor
window.addEventListener('mousemove', (event) => {
  if (event.target === document.documentElement) {
    // Over transparent area - click through
    ipcRenderer.send('set-ignore-mouse', true);
  } else {
    // Over UI element - capture clicks
    ipcRenderer.send('set-ignore-mouse', false);
  }
});
```

This typically means Windows-native window-region tricks / styles and careful testing across:

* Windows 10 vs 11
* NVIDIA/AMD/Intel
* different scaling/DPI settings

You can do it, but don't pretend Electron makes it trivial; it's a native edge.

**Workaround packages:**
- [electron-transparency-mouse-fix](https://www.npmjs.com/package/electron-transparency-mouse-fix)
- [@loomhq/electron-click-through-workaround](https://www.npmjs.com/package/@loomhq/electron-click-through-workaround) (macOS)

---

## 4) IPC patterns for multi-window overlay apps

With multiple windows (main process, overlay renderer, popover renderer), you need clear IPC patterns. Electron uses `ipcMain` (main process) and `ipcRenderer` (renderer) with `contextBridge` for secure exposure.

**Reference:**
- [Electron IPC Tutorial](https://www.electronjs.org/docs/latest/tutorial/ipc)
- [ipcMain API](https://www.electronjs.org/docs/latest/api/ipc-main)
- [ipcRenderer API](https://www.electronjs.org/docs/latest/api/ipc-renderer)
- [contextBridge API](https://www.electronjs.org/docs/latest/api/context-bridge)
- [Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)

### Recommended architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Main Process                          │
│  - Window lifecycle                                      │
│  - Global hotkey registration (globalShortcut)          │
│  - Tray management                                       │
│  - Audio/mic management                                  │
│  - Backend communication (HTTP/WebSocket to your API)   │
│  - IPC hub (routes messages between windows)            │
└────────────────┬──────────────────┬─────────────────────┘
                 │                  │
        ipcMain.handle       webContents.send
                 │                  │
    ┌────────────▼───┐    ┌────────▼────────┐
    │ Overlay Window │    │ Popover Window  │
    │  (preload.js)  │    │   (preload.js)  │
    │                │    │                 │
    │ Status display │    │ Settings, modes │
    │ Minimal UI     │    │ Transcript view │
    └────────────────┘    └─────────────────┘
```

### Preload script pattern (secure)

```javascript
// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  // Renderer → Main (request/response)
  getRecordingState: () => ipcRenderer.invoke('get-recording-state'),
  
  // Renderer → Main (fire-and-forget)
  requestStartRecording: () => ipcRenderer.send('start-recording'),
  
  // Main → Renderer (listen for updates)
  onStateChange: (callback) => {
    ipcRenderer.on('state-changed', (_event, state) => callback(state));
  },
  
  // Cleanup
  removeStateListener: () => {
    ipcRenderer.removeAllListeners('state-changed');
  }
});
```

### Main process handlers

```javascript
// main.js
const { ipcMain } = require('electron');

// Request/response pattern (preferred for queries)
ipcMain.handle('get-recording-state', async () => {
  return { isRecording: recorder.isActive, duration: recorder.duration };
});

// Fire-and-forget pattern (for commands)
ipcMain.on('start-recording', (event) => {
  recorder.start();
  // Broadcast state change to all windows
  overlayWindow.webContents.send('state-changed', { isRecording: true });
  popoverWindow?.webContents.send('state-changed', { isRecording: true });
});
```

### Key IPC patterns for overlays

| Pattern | Use case | API |
|---------|----------|-----|
| **Invoke/Handle** | Query state, get data | `ipcRenderer.invoke()` / `ipcMain.handle()` |
| **Send/On** | Commands, fire-and-forget | `ipcRenderer.send()` / `ipcMain.on()` |
| **Broadcast** | Main → all renderers | `webContents.send()` |
| **Window-specific** | Main → specific window | `specificWindow.webContents.send()` |

### Hotkey → overlay flow

```javascript
// main.js
const { globalShortcut } = require('electron');

app.whenReady().then(() => {
  // Register global hotkey (works even when app not focused)
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    // Toggle recording
    if (recorder.isActive) {
      recorder.stop();
    } else {
      recorder.start();
    }
    // Update overlay
    overlayWindow.webContents.send('state-changed', { 
      isRecording: recorder.isActive 
    });
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
```

**Reference:** [globalShortcut API](https://www.electronjs.org/docs/latest/api/global-shortcut), [Keyboard Shortcuts Tutorial](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts)

---

## 5) Responsiveness: what makes it feel instant

### Pre-warm windows

Don't create/destroy windows on activation. Create them at startup (hidden) and show/hide + reposition:

```javascript
function createOverlayWindow() {
  const overlay = new BrowserWindow({
    show: false,  // Create hidden
    // ... other options
  });
  overlay.loadFile('overlay.html');
  overlay.once('ready-to-show', () => {
    // Window is now "warm" - can show instantly later
  });
  return overlay;
}

// Later, when needed:
overlayWindow.setPosition(x, y);
overlayWindow.show();
```

### Avoid heavyweight rendering in overlay

In the overlay renderer:

* Prefer minimal DOM, minimal layout thrash.
* Use requestAnimationFrame only when needed.
* Animate transforms/opacity rather than triggering layout.

### Be suspicious of "nice blur"

Blur/glass effects can look great but can introduce unpredictable latency and GPU issues on some setups. If you add it, make it optional or degrade gracefully.

Note: CSS `backdrop-filter: blur()` only affects the web content, not content behind the window. True OS-level blur requires platform-specific approaches.

---

## 6) Multi-monitor and DPI positioning

When positioning an overlay, you need to handle multiple displays and varying DPI scales.

**Reference:** [Electron screen API](https://www.electronjs.org/docs/latest/api/screen), [Display Object](https://www.electronjs.org/docs/latest/api/structures/display)

### Getting display information

```javascript
const { screen } = require('electron');

// Get all displays
const displays = screen.getAllDisplays();

// Get primary display
const primary = screen.getPrimaryDisplay();

// Get display containing a point
const displayAtCursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

// Get display for existing window
const displayForWindow = screen.getDisplayMatching(existingWindow.getBounds());
```

### Display object properties

```javascript
{
  id: 123,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },      // Full display area
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },    // Minus taskbar
  scaleFactor: 1.5,                                        // DPI scale (1.0 = 96 DPI)
  rotation: 0                                              // 0, 90, 180, 270
}
```

### Positioning on the correct monitor

```javascript
function positionOverlayOnActiveDisplay() {
  // Option 1: Follow cursor
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  
  // Option 2: Follow focused window (if you track it)
  // const display = screen.getDisplayMatching(focusedAppBounds);
  
  // Position in top-right of work area (avoiding taskbar)
  const { workArea } = display;
  const overlayWidth = 200;
  const overlayHeight = 60;
  const margin = 20;
  
  overlayWindow.setPosition(
    workArea.x + workArea.width - overlayWidth - margin,
    workArea.y + margin
  );
}
```

### DPI awareness

Electron uses DIP (device-independent pixels) for positioning, which handles most scaling automatically. However:

```javascript
// Convert screen physical point to DIP (if needed)
const dipPoint = screen.screenToDipPoint({ x: physicalX, y: physicalY });

// Get scale factor for calculations
const { scaleFactor } = screen.getDisplayNearestPoint(point);
```

### Listening for display changes

```javascript
screen.on('display-added', (event, newDisplay) => {
  // Handle new monitor
});

screen.on('display-removed', (event, oldDisplay) => {
  // Reposition if overlay was on removed display
});

screen.on('display-metrics-changed', (event, display, changedMetrics) => {
  // changedMetrics: ['bounds', 'workArea', 'scaleFactor', 'rotation']
  // Reposition if needed
});
```

---

## 7) UI structure: what to build in the renderer (without prescribing files)

### Overlay window UI primitives

Keep it to a tiny set of states:

* idle
* recording (VAD / mic live)
* processing
* success/failure feedback (short-lived)
* mode indicator (dictation vs command mode)

This maps to "fast status overlay," not a mini app.

### Popover UI primitives (optional)

* transcript preview
* "apply/undo" affordance
* mode toggles
* quick settings (mic, language, privacy, etc.)

Popover is where you can afford a "real UI framework feel."

---

## 8) Reference documentation

Core Electron APIs for overlay development:

| Topic | Documentation |
|-------|---------------|
| **Window creation** | [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) |
| **Window options** | [BaseWindowConstructorOptions](https://www.electronjs.org/docs/latest/api/structures/base-window-options) |
| **Frameless windows** | [Custom Window Styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles) |
| **IPC communication** | [IPC Tutorial](https://www.electronjs.org/docs/latest/tutorial/ipc) |
| **ipcMain** | [ipcMain API](https://www.electronjs.org/docs/latest/api/ipc-main) |
| **ipcRenderer** | [ipcRenderer API](https://www.electronjs.org/docs/latest/api/ipc-renderer) |
| **contextBridge** | [contextBridge API](https://www.electronjs.org/docs/latest/api/context-bridge) |
| **Context isolation** | [Context Isolation Guide](https://www.electronjs.org/docs/latest/tutorial/context-isolation) |
| **Preload scripts** | [Preload Tutorial](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload) |
| **Global hotkeys** | [globalShortcut API](https://www.electronjs.org/docs/latest/api/global-shortcut) |
| **Keyboard shortcuts** | [Keyboard Shortcuts Tutorial](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts) |
| **Multi-monitor** | [screen API](https://www.electronjs.org/docs/latest/api/screen) |
| **Display info** | [Display Object](https://www.electronjs.org/docs/latest/api/structures/display) |

### Known issues and discussions

These GitHub issues document the edge cases and limitations you'll encounter:

| Issue | Topic |
|-------|-------|
| [#10078](https://github.com/electron/electron/issues/10078) | alwaysOnTop over fullscreen apps |
| [#1335](https://github.com/electron/electron/issues/1335) | Support click-through of transparency |
| [#23042](https://github.com/electron/electron/issues/23042) | Click-through frameless transparent window issues |
| [#33281](https://github.com/electron/electron/issues/33281) | setIgnoreMouseEvents forwarding limitations |
| [#38396](https://github.com/electron/electron/issues/38396) | Partial click-through feature request |

### Workaround packages

* [electron-transparency-mouse-fix](https://www.npmjs.com/package/electron-transparency-mouse-fix) - Click-through workaround
* [@loomhq/electron-click-through-workaround](https://www.npmjs.com/package/@loomhq/electron-click-through-workaround) - macOS click-through fix

---

## 9) Recommended default approach

To avoid common pitfalls:

* Treat the overlay as **mostly non-interactive** (hotkeys drive it).
* Use a **separate popover** for anything that requires mouse/focus.
* Pre-create windows and keep them warm.
* Avoid partial click-through unless explicitly required.
* Be conservative with transparency + blur (opt-in, degrade gracefully).
* Use `ipcMain.handle()` / `ipcRenderer.invoke()` for request/response patterns.
* Use `webContents.send()` to push state updates from main to renderers.
* Always use `contextBridge` — never expose `ipcRenderer` directly.
* Test on multiple monitors with different DPI settings.
