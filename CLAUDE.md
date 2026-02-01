# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Murmur is a desktop voice transcription app with two components:
- **app/** - Electron frontend (Svelte 5, TypeScript, Tailwind CSS v4)
- **server/** - Python backend (FastAPI, faster-whisper)

Communication between them uses a custom WebSocket protocol on port 51717 (documented in `docs/protocol.md`).

## Commands

### App (Electron) - uses `bun`

Commands must run on Windows (PowerShell), not WSL:
```powershell
# From app/ directory
bun run dev          # Development mode (hot reload)
bun run build        # Production build
bun run package:win  # Build Windows installer
bun run clear-data   # Clear local app data
```

From WSL, prefix with PowerShell:
```bash
/mnt/c/Program\ Files/PowerShell/7/pwsh.exe -NoProfile -Command "cd C:\path\to\app; bun run dev"
```

### Server (Python) - uses `uv` and `just`

From `server/` directory (commands run via PowerShell automatically):
```bash
just start      # Start server (foreground)
just start-bg   # Start server (background)
just stop       # Stop server (kills port 51717)
just status     # Check if server is running
just test       # Run pytest
```

## Architecture

### Electron Multi-Window Design

**Overlay Window** (`src/main/windows/overlay.ts`):
- Frameless, transparent, always-on-top
- Non-focusable, click-through
- Pre-warmed (created hidden at startup, shown/hidden on demand)
- Positioned bottom-center of active display

**Main Window** (`src/main/windows/main.ts`):
- Standard window for settings/history
- Hides on close (lives in tray)

### IPC Pattern

Main process owns all state. Renderers are pure UI consumers.

```
Main Process                    Renderer (Overlay/App)
─────────────                   ──────────────────────
Services (hotkey, tray,    ──→  Preload script exposes API
transcription, clipboard)       via contextBridge
        │
        └──→ webContents.send() pushes state updates
```

- Preload scripts: `src/main/preload/overlay.ts`, `src/main/preload/main.ts`
- IPC channels defined in: `src/shared/constants.ts`

### Audio Pipeline

```
Microphone → AudioWorklet → IPC → TranscriptionService → WebSocket → Server
                │
                └→ Level metering → Waveform visualization
```

- Audio worklet: `src/renderer/overlay/audio-processor.worklet.ts`
- Capture: `src/renderer/overlay/audio-capture.ts`
- Format: 16-bit PCM, 16kHz mono

### Frontend Stack

- **Svelte 5** with runes (`$state`, `$derived`, `$effect`, `$props`)
- **Tailwind CSS v4** (imported via `@import "tailwindcss"`)
- **IMPORTANT: Use Tailwind classes exclusively** - no custom CSS in `<style>` blocks. Use Tailwind utilities and arbitrary values (e.g., `w-[150px]`, `bg-[#0a0a0a]`) for all styling.
- **Always use proper cursors** - buttons and clickable elements must have `cursor-pointer`, disabled elements `cursor-not-allowed`, draggable areas `cursor-grab`/`cursor-grabbing`, etc. Proper cursor feedback is critical for UX.
- Path aliases: `$lib/` → `src/renderer/lib/`, `$shared/` → `src/shared/`

### Data Storage

- **Settings**: `electron-store` (JSON)
- **History**: `better-sqlite3` (SQLite)

## Key Files

| Purpose | Location |
|---------|----------|
| Main process entry | `app/src/main/index.ts` |
| Overlay window | `app/src/main/windows/overlay.ts` |
| Main window | `app/src/main/windows/main.ts` |
| Global hotkey | `app/src/main/services/hotkey.ts` |
| WebSocket client | `app/src/main/services/transcription.ts` |
| Shared types | `app/src/shared/types.ts` |
| Protocol spec | `docs/protocol.md` |
| UI planning | `app/plan.md` (note: main UI section at top is outdated) |

## Build Configuration

- Vite config: `app/vite.config.ts` (multi-entry: overlay + app)
- Main process build: `app/scripts/build-main.js` (esbuild)
- TypeScript: `tsconfig.json` (renderer), `tsconfig.main.json` (main process)

## Important Guidelines

- **Never fake or approximate assets** - When using images, icons, or other assets, always use the actual files. Never create SVG approximations or recreate assets from scratch. If there are path/access issues, ask about the best way to resolve them.
- **Ask when there are multiple approaches** - When a task has multiple valid solutions and the "right" choice isn't obvious, ask which approach is preferred rather than picking one arbitrarily.
