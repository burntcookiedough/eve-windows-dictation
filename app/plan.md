# Murmur UI Planning Document

> **Status:** Draft for discussion  
> **Last updated:** 2025-01-31

This document outlines the UI architecture, features, and implementation plan for the Murmur desktop application. It's meant to be a living document that we refine through discussion.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Framework Decision](#2-framework-decision)
3. [Window Architecture](#3-window-architecture)
4. [The Overlay System (Core UX)](#4-the-overlay-system-core-ux)
5. [Main Application Window](#5-main-application-window)
6. [System Tray Integration](#6-system-tray-integration)
7. [Settings System](#7-settings-system)
8. [History & Transcription Management](#8-history--transcription-management)
9. [Visual Design Direction](#9-visual-design-direction)
10. [Data Flow & State Management](#10-data-flow--state-management)
11. [Technology Decisions (Please Confirm Each)](#11-technology-decisions-please-confirm-each)
12. [Project Setup Commands](#12-project-setup-commands)
13. [Directory Structure (Final)](#13-directory-structure-final)
14. [Version Roadmap](#14-version-roadmap)
15. [Open Questions](#15-open-questions)

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MAIN PROCESS                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │   Window    │  │   Global    │  │   System    │  │  WebSocket │ │
│  │  Lifecycle  │  │   Hotkey    │  │    Tray     │  │   Client   │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘ │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │    Audio    │  │   Settings  │  │   History   │  │    IPC     │ │
│  │   Capture   │  │   Store     │  │    Store    │  │    Hub     │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘ │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ IPC (contextBridge)
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
    ┌───────────────┐ ┌───────────┐ ┌─────────────────┐
    │ Overlay Window│ │  Main App │ │ Settings Window │
    │  (Renderer)   │ │  Window   │ │   (Renderer)    │
    │               │ │(Renderer) │ │                 │
    │ • Pill UI     │ │ • History │ │ • Preferences   │
    │ • Waveform    │ │ • Quick   │ │ • Hotkey config │
    │ • Text feed   │ │   actions │ │ • Audio setup   │
    └───────────────┘ └───────────┘ └─────────────────┘
```

### Key Principles

1. **Main process owns all "backend" concerns**: audio capture, WebSocket connection to transcription server, settings persistence, history storage
2. **Renderers are pure UI**: they receive state via IPC and render it
3. **Overlay is kept minimal**: fast, non-interactive, hotkey-driven
4. **Windows are pre-warmed**: created at startup, shown/hidden as needed

---

## 2. Framework Decision

### ✅ DECIDED: Svelte 5 + shadcn-svelte + Tailwind v4

**Stack:**
- **Svelte 5** - UI framework (runes-based reactivity)
- **shadcn-svelte** - Component library (8k+ stars, actively maintained)
- **Tailwind CSS v4** - Styling
- **Vite** - Build tool
- **Bun** - Package manager & runtime

**Why this stack:**

1. **Overlay performance**: Svelte's compiled approach = minimal runtime overhead. Critical for 60fps waveform updates.

2. **shadcn-svelte exists**: Full port of shadcn/ui for Svelte, built on Bits UI (headless primitives). We get polished, accessible components without sacrificing Svelte's benefits.

3. **Svelte 5 runes**: The new `$state`, `$derived`, `$effect` system is clean and explicit.

4. **Tailwind v4**: Latest version, works great with shadcn-svelte.

5. **No SvelteKit**: For an Electron app, we don't need SvelteKit's routing/SSR. Plain Svelte + Vite is simpler.

**Component strategy:**
- **Overlay window**: Custom components (Pill, Waveform, TextDisplay) - need precise control
- **Main/Settings windows**: shadcn-svelte components where possible (buttons, inputs, dialogs, etc.)

---

## 3. Window Architecture

Based on the Electron research, we'll use multiple windows:

### 3.1 Overlay Window

**Purpose**: The always-visible pill that appears during transcription

**Characteristics**:
- Frameless, transparent
- Always on top
- Non-focusable (doesn't steal focus)
- Click-through (non-interactive)
- Pre-warmed (created at startup, hidden)
- Positioned on the display with the active window

**BrowserWindow config**:
```javascript
{
  frame: false,
  transparent: true,
  resizable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  focusable: false,
  thickFrame: false,
  hasShadow: false,
  show: false,  // Pre-warm hidden
  width: 400,   // Enough for pill + text above
  height: 200,
  webPreferences: {
    preload: 'overlay-preload.js',
    contextIsolation: true,
    nodeIntegration: false
  }
}
```

### 3.2 Main Application Window

**Purpose**: History view, quick actions, primary app interface

**Characteristics**:
- Standard window (can be frameless with custom titlebar if desired)
- Hidden by default (app lives in tray)
- Opens from tray icon or hotkey
- Contains history, quick settings access

### 3.3 Settings Window (Optional: could be part of main window)

**Purpose**: Full settings/preferences UI

**Characteristics**:
- Modal or separate window
- Standard window behavior
- Could be a route in the main window instead

### Decision needed:
- [x] Settings as separate window or tab/route in main window? → **Decide in v1** (v0 has no settings)
- [x] Custom titlebar for main window or native? → **Decide in v1**

---

## 4. The Overlay System (Core UX)

This is the heart of the app. Let's break it down in detail.

### 4.1 Activation Flow

```
User presses global hotkey (e.g., Ctrl+Shift+Space)
        │
        ▼
┌─────────────────────────────────────┐
│ Main process receives hotkey event  │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│ Determine which display to show on  │
│ (display with active window/cursor) │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│ Position overlay window:            │
│ Lower-center of that display        │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│ Show overlay window                 │
│ Start audio capture                 │
│ Connect WebSocket to server         │
│ Send protocol `start` frame         │
└─────────────────────────────────────┘
        │
        ▼
    [Recording active]
```

### 4.2 Overlay Visual Structure

```
                    ┌─────────────────────────────────────┐
                    │         TEXT DISPLAY AREA           │
                    │                                     │
                    │   "Hello, this is the transcribed"  │
                    │                                     │
                    │    (partials fade in/update here)   │
                    └─────────────────────────────────────┘
                                     │
                                     │ ~16px gap
                                     │
                    ┌─────────────────────────────────────┐
                    │            PILL / BAR               │
                    │  ┌─────────────────────────────┐    │
                    │  │  ▁▂▃▅▂▁▃▅▇▅▃▂▁▂▃▅▃▂▁       │    │
                    │  │       (waveform)             │    │
                    │  └─────────────────────────────┘    │
                    └─────────────────────────────────────┘
                                     │
                              bottom of screen
                              (above taskbar)
```

### 4.3 Overlay States

| State | Visual | Behavior |
|-------|--------|----------|
| **Idle** | Hidden | Overlay not visible |
| **Listening** | Pill visible, waveform animating | Audio being captured, waiting for speech |
| **Transcribing** | Pill + text above | Partials coming in, text updating |
| **Processing** | Pill shows spinner/pulse | Final transcription being processed |
| **Success** | Brief green flash, then hide | Transcription complete |
| **Error** | Brief red flash, then hide | Something went wrong |

### 4.4 Text Display Behavior

**For partial text (`text:partial` frames)**:
- Replace entire text content (don't append)
- Animate text changes smoothly (fade or typing effect?)
- Text should feel "alive" as it refines

**For final text (`text:final` frames)**:
- Show final text briefly
- Then either:
  - Auto-copy to clipboard and dismiss
  - Or show success state and dismiss

**Animation ideas** (need to decide):
- [ ] Simple crossfade between partial updates
- [ ] Typing/typewriter effect for new characters
- [ ] Word-by-word fade-in
- [ ] Subtle scale animation on text change

### 4.5 Waveform Visualization

**Data source**: Raw PCM audio being captured (not from server)

**Visualization style options**:

1. **Bar graph**: Classic vertical bars (like audio meters)
2. **Smooth wave**: Continuous curved line
3. **Mirrored bars**: Bars going up and down from center
4. **Circular**: Radial visualization (more complex)

**Recommendation**: Mirrored bars (like most voice apps) - familiar, performant, looks good small.

**Technical approach**:
- Main process streams audio level data to overlay via IPC
- Options:
  - Send raw samples, process in renderer (more flexible, more CPU)
  - Send pre-computed RMS/peak values (less flexible, less CPU)
- Recommend: Send pre-computed values at ~30-60fps

### 4.6 Positioning Logic

**✅ DECIDED**: Position on the display where the **focused window** is located. Bottom-center placement.

```javascript
function getOverlayPosition() {
  // Get the display containing the focused window
  // For v0: use cursor position as proxy (simpler)
  // For v1+: could use platform-specific APIs to get actual focused window
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  
  const { workArea } = display; // Excludes taskbar
  
  const overlayWidth = 350;
  const overlayHeight = 150;
  const bottomMargin = 80; // Distance from bottom - TUNEABLE
  
  return {
    x: workArea.x + (workArea.width - overlayWidth) / 2,
    y: workArea.y + workArea.height - overlayHeight - bottomMargin
  };
}
```

**Tuning note**: The exact `bottomMargin`, `overlayWidth`, `overlayHeight` values will be adjusted once we can see it in action.

### 4.7 Deactivation Flow

**Trigger: User presses hotkey again OR silence timeout**

```
Hotkey pressed again / silence_timeout reached
        │
        ▼
┌─────────────────────────────────────┐
│ Send protocol `stop` frame          │
│ (or server sends `closing`)         │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│ Receive `text:final` (if any text)  │
│ Show final text briefly             │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│ Copy text to clipboard (optional)   │
│ Show success feedback               │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│ Hide overlay                        │
│ Stop audio capture                  │
│ Close WebSocket                     │
│ Save to history                     │
└─────────────────────────────────────┘
```

### Decision needed:
- [x] Hold-to-talk vs toggle mode? → **v0: Hold-to-talk only. v1+: Setting to choose.**
- [x] Auto-copy to clipboard on completion? → **Yes, for all versions**
- [ ] Type text into active app (like SuperWhisper)? → **v2+: Yes, as default. With app exclusion list.**
- [ ] Text animation style? → **TBD - need to see options**
- [ ] Waveform style? → **TBD - need to see options**

### Future features (v2+)
- **Auto-paste as default**: Automatically type transcribed text into the active application
- **App exclusion list**: Configure apps where auto-paste should NOT happen
- **Toggle mode option**: Setting to switch between hold-to-talk and toggle
- **Position preference**: Setting to choose overlay position

---

## 5. Main Application Window

### 5.1 Purpose

The main window is where users go when they're NOT actively transcribing. It provides:

1. **History**: View past transcriptions
2. **Quick actions**: Copy, delete, search history
3. **Settings access**: Link to settings
4. **Status**: Server connection status, usage stats

### 5.2 Layout Concept

```
┌──────────────────────────────────────────────────────────────┐
│  ┌─────┐                                          [─] [□] [×]│
│  │ 🎤  │  Murmur                              ⚙️ Settings    │
│  └─────┘                                                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  🔍 Search transcriptions...                                 │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  TODAY                                                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ "Hello, this is a test transcription that I did..."    │ │
│  │ 2:34 PM • 12 seconds • 94% confidence         [📋] [🗑]│ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ "Another transcription from earlier today when I..."   │ │
│  │ 11:20 AM • 8 seconds • 91% confidence         [📋] [🗑]│ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  YESTERDAY                                                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ "Meeting notes: We discussed the quarterly targets..." │ │
│  │ 4:15 PM • 45 seconds • 89% confidence         [📋] [🗑]│ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│                         ... more ...                         │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  ● Connected to server                    Press Ctrl+Shift+M │
└──────────────────────────────────────────────────────────────┘
```

### 5.3 Features

| Feature | Priority | Notes |
|---------|----------|-------|
| History list | P0 | Core feature |
| Copy to clipboard | P0 | One-click copy |
| Delete entry | P0 | Remove from history |
| Search | P1 | Filter by text content |
| Date grouping | P1 | Today, Yesterday, This week, etc. |
| Edit transcription | P2 | Correct mistakes |
| Export history | P2 | JSON, CSV, plain text |
| Keyboard navigation | P1 | Navigate and act without mouse |

### Decision needed (v1+):
- [ ] How much history to keep? (configurable limit, or keep all?)
- [ ] Cloud sync? (probably not for v1)
- [ ] Tags/categories for transcriptions? (v2+)

**Note**: History UI is not in v0. v0 just saves to JSON file for later use.

---

## 6. System Tray Integration

### 6.1 Tray Icon States

| State | Icon | Tooltip |
|-------|------|---------|
| Idle | 🎤 (normal) | "Murmur - Press [hotkey] to start" |
| Recording | 🎤 (red/pulsing) | "Murmur - Recording..." |
| Processing | 🎤 (spinner) | "Murmur - Processing..." |
| Disconnected | 🎤 (gray) | "Murmur - Server disconnected" |
| Error | 🎤 (yellow) | "Murmur - Error (click for details)" |

### 6.2 Tray Menu

```
┌────────────────────────┐
│ Murmur                 │
├────────────────────────┤
│ ▶ Start Recording      │ ← Or "Stop Recording" when active
├────────────────────────┤
│ 📋 History             │
│ ⚙️ Settings            │
├────────────────────────┤
│ 🔗 Connected           │ ← Status indicator
├────────────────────────┤
│ ❌ Quit                │
└────────────────────────┘
```

### 6.3 Tray Behaviors

- **Left-click**: Show/focus main window
- **Right-click**: Show context menu
- **Double-click** (Windows): Show main window

---

## 7. Settings System

### 7.1 Settings Categories

#### General
- [ ] Start on system boot
- [ ] Start minimized to tray
- [ ] Show in taskbar (when main window open)
- [ ] Check for updates automatically

#### Hotkeys
- [ ] Global activation hotkey (default: Ctrl+Shift+Space)
- [ ] Hold-to-talk vs toggle mode
- [ ] Cancel recording hotkey (Escape?)

#### Audio
- [ ] Input device selection
- [ ] Input volume/gain
- [ ] Silence detection threshold
- [ ] Silence timeout duration (maps to protocol `silence_timeout`)

#### Transcription
- [ ] Server URL (default: localhost?)
- [ ] Auto-copy to clipboard
- [ ] Auto-paste into active app (like SuperWhisper)
- [ ] Language preference (if server supports)

#### Appearance
- [ ] Theme (light/dark/system)
- [ ] Overlay position preference (bottom-center, top-right, etc.)
- [ ] Overlay opacity
- [ ] Text size in overlay
- [ ] Waveform style

#### History
- [ ] Keep history (on/off)
- [ ] History retention period
- [ ] Storage location

### 7.2 Settings Storage

Use `electron-store` or similar for persistent settings:

```javascript
// In main process
import Store from 'electron-store';

const settings = new Store({
  defaults: {
    hotkey: 'CommandOrControl+Shift+Space',
    holdToTalk: false,
    autoCopy: true,
    silenceTimeout: 5,
    theme: 'system',
    // ...
  }
});
```

### Versioning notes:
- **v0**: No settings UI. All values hardcoded.
- **v1**: Settings UI with: hotkey, audio device, silence timeout, server URL, start on boot
- **v2+**: Auto-paste settings, app exclusions, themes, position preferences

---

## 8. History & Transcription Management

### 8.1 Data Model

```typescript
interface TranscriptionEntry {
  id: string;              // UUID
  timestamp: number;       // Unix timestamp
  text: string;            // Final transcribed text
  audioDuration: number;   // Seconds
  confidence: number;      // 0.0 - 1.0
  // Metadata
  transcriptionTime: number; // How long inference took
  editedAt?: number;       // If user edited the text
  originalText?: string;   // Original before edit
}
```

### 8.2 Storage

**✅ DECIDED**: SQLite from the start (via `better-sqlite3`)

| What | Storage | Why |
|------|---------|-----|
| **History** | SQLite | Queryable, handles large datasets, future-proof |
| **Settings** | electron-store (JSON) | Simple key-value, atomic writes |

**Why SQLite over JSON for history:**
- Full-text search capability (v2+)
- No performance degradation as history grows
- Proper querying for date ranges, filtering
- Single dependency (`better-sqlite3`) is well-maintained and synchronous (works great in Electron main process)

### 8.3 History Features (v1)

- List all transcriptions, newest first
- Search/filter by text content
- Copy any entry to clipboard
- Delete entries
- Basic date grouping (Today, Yesterday, This week, Older)

### 8.4 History Features (v2+)

- Full-text search
- Tags/categories
- Export (JSON, CSV, plain text)
- Bulk operations
- Favorites/pinning

---

## 9. Visual Design Direction

### 9.1 Design Principles

1. **Minimal & unobtrusive**: The overlay should feel like part of the OS, not a loud app
2. **Fast feedback**: Every state change should be immediately visible
3. **Modern but not flashy**: Clean, rounded corners, subtle shadows, no gimmicks
4. **Dark-mode friendly**: Default to following system theme
5. **Accessible**: Good contrast, not too small

### 9.2 Color Palette (Dark Mode)

```
Background (pill):    #1a1a1a (near black, slightly transparent)
Text primary:         #ffffff
Text secondary:       #a0a0a0
Accent (active):      #3b82f6 (blue)
Success:              #22c55e (green)
Error:                #ef4444 (red)
Waveform bars:        #3b82f6 → #60a5fa (gradient)
```

### 9.3 Typography

- **Font**: System font stack (San Francisco on Mac, Segoe UI on Windows)
- **Overlay text**: 16-18px, medium weight
- **History items**: 14px body, 12px metadata

### 9.4 Pill Design

```
┌──────────────────────────────────────┐
│                                      │  ← Rounded corners (16px radius)
│   ▁▂▃▅▇▅▃▂▁▂▃▅▃▂▁▂▃▅▇▅▃▂▁          │  ← Waveform (centered)
│                                      │
└──────────────────────────────────────┘
      ↑
   Subtle shadow, slight transparency (~95% opacity)
   Width: ~300px, Height: ~50px
```

### 9.5 Animation Specs

| Element | Animation | Duration | Easing |
|---------|-----------|----------|--------|
| Overlay show | Fade in + slide up | 150ms | ease-out |
| Overlay hide | Fade out + slide down | 100ms | ease-in |
| Text partial update | Crossfade | 100ms | linear |
| Waveform bars | Height change | 16ms (60fps) | linear |
| Success flash | Green pulse | 300ms | ease-in-out |

### Decision needed:
- [ ] Light mode support for v1?
- [ ] Exact dimensions for pill?
- [ ] Blur/glass effect? (may have performance issues)

---

## 10. Data Flow & State Management

### 10.1 State Categories

**Main Process State** (source of truth):
- Recording state (idle, recording, processing)
- Connection state (disconnected, connecting, connected, error)
- Audio levels (for waveform)
- Current transcription (partial text, final text)
- Settings
- History

**Renderer State** (derived from main process):
- UI-specific state (animations, hover states, etc.)
- Derived from main process via IPC

### 10.2 IPC Channels

```typescript
// Main → Renderer (state updates)
'state:recording'      // { isRecording: boolean, state: 'idle' | 'recording' | 'processing' }
'state:connection'     // { status: 'connected' | 'disconnected' | 'error', error?: string }
'state:audio-level'    // { levels: number[] } // For waveform, ~30-60fps
'state:transcription'  // { type: 'partial' | 'final', text: string, confidence: number }

// Renderer → Main (commands)
'command:start-recording'
'command:stop-recording'
'command:copy-to-clipboard'  // { text: string }
'command:delete-history'     // { id: string }
'command:update-setting'     // { key: string, value: any }

// Request/Response (invoke/handle)
'get:settings'         // Returns all settings
'get:history'          // Returns history entries
'get:history-entry'    // { id: string } → TranscriptionEntry
```

### 10.3 Preload API Design

```typescript
// overlay-preload.ts
contextBridge.exposeInMainWorld('murmur', {
  // State subscriptions
  onRecordingState: (callback: (state: RecordingState) => void) => void,
  onAudioLevel: (callback: (levels: number[]) => void) => void,
  onTranscription: (callback: (data: TranscriptionData) => void) => void,
  
  // Cleanup
  removeAllListeners: () => void,
});

// main-preload.ts (for main app window)
contextBridge.exposeInMainWorld('murmur', {
  // Everything from overlay, plus:
  getHistory: () => Promise<TranscriptionEntry[]>,
  deleteHistoryEntry: (id: string) => Promise<void>,
  copyToClipboard: (text: string) => Promise<void>,
  getSettings: () => Promise<Settings>,
  updateSetting: (key: string, value: any) => Promise<void>,
  // ...
});
```

---

## 11. Technology Decisions (Please Confirm Each)

This section lists every technology decision. Please confirm each one before we start building.

### 11.1 Core Stack

| Decision | Choice | Version | Notes |
|----------|--------|---------|-------|
| **Runtime** | Electron | 34+ | Desktop app framework |
| **Package manager** | Bun | latest | Fast, TypeScript-native |
| **Language** | TypeScript | 5.x | Strict mode enabled |
| **UI framework** | Svelte | 5.x | Runes-based reactivity |
| **Component library** | shadcn-svelte | latest | For main/settings windows |
| **CSS framework** | Tailwind CSS | 4.x | Utility-first styling |
| **Build tool** | Vite | 6.x | Fast dev server, bundling |

**Confirm?** [x] ✅

---

### 11.2 Electron-Specific

| Decision | Choice | Notes |
|----------|--------|-------|
| **Electron builder** | electron-builder | For packaging/distribution |
| **Main process bundler** | esbuild (via Vite) | Fast TS compilation |
| **Preload bundling** | Vite | Separate entry points |
| **Context isolation** | Yes (always) | Security best practice |
| **Node integration** | No (disabled) | Security best practice |

**Confirm?** [x] ✅

---

### 11.3 Data Storage

| What | How | Format | Location |
|------|-----|--------|----------|
| **Settings** | electron-store | JSON | `%APPDATA%/murmur/config.json` |
| **History** | SQLite | DB file | `%APPDATA%/murmur/history.db` |

**Note**: 
- Settings use electron-store (handles atomic writes, schema validation)
- History uses SQLite from the start - no JSON intermediate step
- v0 may not have history UI, but if we save transcriptions, they go to SQLite

**Confirm?** [x] ✅

---

### 11.4 Audio

| Decision | Choice | Notes |
|----------|--------|-------|
| **Audio capture** | Web Audio API | Via navigator.mediaDevices in main process |
| **Audio format** | PCM 16-bit mono, 16kHz | As per protocol spec |
| **Level metering** | Computed in main process | RMS values sent to overlay at ~30fps |

**Alternative**: Could use a native module like `node-audiorecorder` if Web Audio causes issues. Start with Web Audio.

**Future setting (v2+)**: Configurable FPS for RMS audio level updates (waveform refresh rate).

**Confirm?** [x] ✅

---

### 11.5 Networking

| Decision | Choice | Notes |
|----------|--------|-------|
| **WebSocket client** | Native `ws` or `WebSocket` | For transcription protocol |
| **Protocol** | Your custom protocol | As documented in protocol.md |
| **Server URL (v0)** | Hardcoded | `ws://localhost:51717/transcribe` |
| **Server URL (v1+)** | Configurable | Via settings |

**Confirm?** [x] ✅

---

### 11.6 UI Component Strategy

| Window | Component Source | Why |
|--------|-----------------|-----|
| **Overlay** | Custom Svelte components | Need precise control for animations, waveform |
| **Main window** | shadcn-svelte | Standard UI patterns (lists, buttons, etc.) |
| **Settings** | shadcn-svelte | Forms, inputs, toggles |

**Custom overlay components to build:**
- `Pill.svelte` - The main container with rounded corners
- `Waveform.svelte` - Audio level visualization
- `TextDisplay.svelte` - Animated text display for partials/final

**Confirm?** [x] ✅

---

### 11.7 IPC Architecture

| Pattern | Use Case | API |
|---------|----------|-----|
| **invoke/handle** | Get data (settings, history) | `ipcRenderer.invoke()` / `ipcMain.handle()` |
| **send/on** | Commands (start, stop) | `ipcRenderer.send()` / `ipcMain.on()` |
| **push from main** | State updates (audio levels, transcription) | `webContents.send()` |

**All IPC exposed via `contextBridge`** - never expose raw ipcRenderer.

**Confirm?** [x] ✅

---

### 11.8 Platform Support

| Version | Platforms | Notes |
|---------|-----------|-------|
| **v0** | Windows only | |
| **v1** | Windows only | |
| **v2+** | Windows only | Server is Windows-only; cross-platform not planned |

**Rationale**: The transcription server uses Windows-only features. Cross-platform support would require server changes first, which is out of scope.

**Confirm?** [x] ✅

---

### 11.9 Hardcoded Values for v0

These will be configurable in v1, but hardcoded in v0:

| Setting | v0 Value | Notes |
|---------|----------|-------|
| **Global hotkey** | `Ctrl+Shift+Space` | Hold to talk |
| **Server URL** | `ws://localhost:51717/transcribe` | Default server address |
| **Silence timeout** | `3` seconds | Sent in protocol `start` frame |
| **Audio device** | System default | No selection UI |
| **Overlay position** | Bottom-center | Fixed |

**Confirm?** [x] ✅

---

## 12. Project Setup Commands

### 12.1 Prerequisites

```bash
# Ensure Bun is installed
bun --version  # Should be 1.0+

# Ensure Node.js is available (Electron needs it)
node --version  # Should be 20+
```

### 12.2 Initialize Project

```bash
# Navigate to your app directory
cd /path/to/murmur/app

# Initialize with Bun
bun init -y

# Install Electron and build tools
bun add -d electron electron-builder vite @sveltejs/vite-plugin-svelte

# Install Svelte 5
bun add svelte

# Install Tailwind v4
bun add -d tailwindcss @tailwindcss/vite

# Install shadcn-svelte dependencies
bun add bits-ui clsx tailwind-merge tailwind-variants

# Install electron-store for settings
bun add electron-store

# Install SQLite for history (better-sqlite3 is synchronous, works well with Electron)
bun add better-sqlite3
bun add -d @types/better-sqlite3

# Install TypeScript and types
bun add -d typescript @types/node
```

### 12.3 Initialize shadcn-svelte

```bash
# Run the shadcn-svelte CLI
bunx shadcn-svelte@next init

# When prompted:
# - Style: Default (or New York)
# - Base color: Slate (or your preference)
# - CSS variables: Yes
# - Global CSS location: src/renderer/app.css (adjust as needed)
# - Tailwind config: tailwind.config.ts
# - Components location: src/renderer/components/ui
# - Utils location: src/renderer/lib/utils
```

### 12.4 Project Structure Setup

```bash
# Create directory structure
mkdir -p src/main/windows
mkdir -p src/main/services
mkdir -p src/main/ipc
mkdir -p src/main/preload
mkdir -p src/renderer/overlay/components
mkdir -p src/renderer/app/components
mkdir -p src/shared
mkdir -p resources/icons
```

### 12.5 Configuration Files

These files need to be created (templates will be provided when we start building):

```
app/
├── package.json          # Dependencies, scripts
├── tsconfig.json         # TypeScript config
├── vite.config.ts        # Vite config (multi-entry for renderers)
├── tailwind.config.ts    # Tailwind config
├── electron-builder.json # Packaging config
├── components.json       # shadcn-svelte config
└── src/
    └── ...
```

### 12.6 Package.json Scripts

```json
{
  "scripts": {
    "dev": "vite",
    "dev:electron": "electron .",
    "build": "vite build && tsc -p tsconfig.main.json",
    "preview": "vite preview",
    "package": "electron-builder",
    "package:win": "electron-builder --win",
    "package:mac": "electron-builder --mac",
    "package:linux": "electron-builder --linux"
  }
}
```

### 12.7 Development Workflow

```bash
# Terminal 1: Run Vite dev server (for renderer hot reload)
bun run dev

# Terminal 2: Run Electron (connects to Vite dev server)
bun run dev:electron

# Or combined (if we set up concurrently):
bun run dev:all
```

### 12.8 First Run Checklist

After setup, verify:

- [ ] `bun run dev` starts Vite without errors
- [ ] `bun run dev:electron` opens Electron window
- [ ] Electron window loads from Vite dev server
- [ ] Hot reload works when editing Svelte files
- [ ] Tailwind classes are applied
- [ ] TypeScript compilation works

---

## 13. Directory Structure (Final)

```
app/
├── package.json
├── tsconfig.json              # Base TS config
├── tsconfig.main.json         # Main process TS config
├── vite.config.ts
├── tailwind.config.ts
├── components.json            # shadcn-svelte
├── electron-builder.json
│
├── src/
│   ├── main/                         # === MAIN PROCESS ===
│   │   ├── index.ts                  # Entry point
│   │   │
│   │   ├── windows/
│   │   │   ├── overlay.ts            # Overlay window creation/management
│   │   │   └── main-window.ts        # Main app window (v1+)
│   │   │
│   │   ├── services/
│   │   │   ├── audio.ts              # Audio capture, level metering
│   │   │   ├── transcription.ts      # WebSocket client, protocol impl
│   │   │   ├── hotkey.ts             # Global hotkey registration
│   │   │   ├── tray.ts               # System tray icon/menu
│   │   │   ├── clipboard.ts          # Clipboard operations
│   │   │   ├── settings.ts           # Settings store (electron-store)
│   │   │   └── history.ts            # History store (SQLite via better-sqlite3)
│   │   │
│   │   ├── ipc/
│   │   │   ├── handlers.ts           # All IPC handlers
│   │   │   └── channels.ts           # Channel name constants
│   │   │
│   │   └── preload/
│   │       ├── overlay.ts            # Preload for overlay window
│   │       └── main.ts               # Preload for main window (v1+)
│   │
│   ├── renderer/                     # === RENDERER PROCESSES ===
│   │   ├── overlay/                  # Overlay window
│   │   │   ├── index.html
│   │   │   ├── main.ts               # Svelte mount
│   │   │   ├── App.svelte
│   │   │   ├── app.css               # Tailwind imports
│   │   │   └── components/
│   │   │       ├── Pill.svelte       # Main pill container
│   │   │       ├── Waveform.svelte   # Audio visualization
│   │   │       └── TextDisplay.svelte # Transcription text
│   │   │
│   │   ├── app/                      # Main app window (v1+)
│   │   │   ├── index.html
│   │   │   ├── main.ts
│   │   │   ├── App.svelte
│   │   │   ├── app.css
│   │   │   └── components/
│   │   │       ├── ui/               # shadcn-svelte components
│   │   │       ├── HistoryList.svelte
│   │   │       └── ...
│   │   │
│   │   └── lib/                      # Shared renderer utilities
│   │       └── utils.ts              # shadcn-svelte utils (cn function)
│   │
│   └── shared/                       # === SHARED (main + renderer) ===
│       ├── types.ts                  # TypeScript interfaces
│       ├── constants.ts              # Shared constants
│       └── protocol.ts               # Protocol frame types
│
├── resources/
│   ├── icon.ico                      # Windows app icon
│   ├── icon.icns                     # macOS app icon
│   ├── icon.png                      # Linux app icon
│   └── tray/
│       ├── tray-idle.png
│       ├── tray-recording.png
│       └── tray-error.png
│
└── dist/                             # Build output (gitignored)
    ├── main/                         # Compiled main process
    ├── preload/                      # Compiled preload scripts
    └── renderer/                     # Bundled renderer code
```

---

## 14. Version Roadmap

### v0 - "Make it feel right"

**Goal**: Get the core overlay UX working and looking exactly how we want. No settings, no history UI, just the overlay experience.

**Features**:
- [x] Global hotkey (hardcoded, e.g., `Ctrl+Shift+Space`)
- [x] Hold-to-talk activation
- [x] Overlay appears on focused window's display
- [x] Pill with waveform visualization
- [x] Text display above pill (partials → final)
- [x] Auto-copy final text to clipboard
- [x] Basic system tray icon (just to keep app running)
- [x] WebSocket connection to transcription server (hardcoded URL)

**NOT in v0**:
- No settings UI
- No history view
- No configurable hotkey
- No audio device selection (uses default)
- No themes

**Success criteria**: Press hotkey → speak → see transcription → text is in clipboard. Feels smooth, looks good.

---

### v1 - "Make it an app"

**Goal**: Turn the prototype into a real application with persistence and configuration.

**Features** (in addition to v0):
- [ ] Settings UI
  - Hotkey configuration
  - Audio device selection
  - Silence timeout
  - Server URL
  - Start on boot
  - Start minimized
- [ ] History view
  - List past transcriptions
  - Copy to clipboard
  - Delete entries
  - Basic date grouping
- [ ] Proper system tray
  - Status indicators
  - Context menu
  - Show/hide main window
- [ ] Error handling & feedback
  - Connection status
  - Error messages

---

### v2+ - "Make it powerful"

**Goal**: Advanced features for power users.

**Features** (ideas, not committed):
- [ ] **Auto-paste**: Type transcribed text directly into active app (default behavior)
- [ ] **App exclusion list**: Apps where auto-paste shouldn't happen
- [ ] **Toggle mode**: Alternative to hold-to-talk
- [ ] **Position preference**: Choose where overlay appears
- [ ] **Waveform FPS setting**: Configurable refresh rate for audio visualization
- [ ] **Search history**: Full-text search
- [ ] **Edit transcriptions**: Correct mistakes
- [ ] **Export history**: JSON, CSV, plain text
- [ ] **Themes**: Light/dark/custom
- [ ] **Multiple languages**: If server supports
- [ ] **Keyboard navigation**: Full keyboard control

---

## 15. Open Questions

Most questions have been resolved. Remaining:

### Still to decide (during implementation)
1. **Cancel behavior?** If user releases hotkey early or presses Escape, what happens to partial transcription? (Probably: discard, don't copy)
2. **Text animation style?** Need to prototype options: crossfade, typewriter, word-by-word, simple replace
3. **Waveform style?** Need to prototype: bars, smooth wave, mirrored bars
4. **Blur/glass effect?** Try it, see if performance is acceptable

### Resolved ✅
- ~~Hold-to-talk vs toggle?~~ → Hold-to-talk for v0, setting later
- ~~What happens to transcribed text?~~ → Auto-copy to clipboard
- ~~Framework?~~ → Svelte 5 + shadcn-svelte + Tailwind v4 + Bun
- ~~Overlay position?~~ → Focused window's display, bottom-center
- ~~Settings window separate or in main?~~ → Decide in v1
- ~~SQLite vs JSON?~~ → JSON for v0/v1, SQLite if needed later
- ~~Auto-paste?~~ → v2+ feature
- ~~What's in v1?~~ → See roadmap above

---

## Next Steps

1. ~~Review this document~~ ✅
2. ~~Finalize framework~~ ✅ Svelte 5 + shadcn-svelte + Tailwind v4 + Bun
3. **Set up project scaffolding** - Electron + Svelte + Vite structure in `/app`
4. **Build v0 overlay** - The core experience
5. **Iterate on feel** - Tune animations, positioning, waveform

---

*Document last updated after discussion. Ready to start building!*
