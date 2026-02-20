# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL: WSL Environment — Read First

**This workspace is opened from WSL but targets Windows.** Both the Electron app and the Python server run on Windows, not Linux.

### Rules for ALL commands (uv, bun, npm, pytest, pip, etc.)

1. **NEVER run `uv`, `bun`, `npm`, `pytest`, `pip`, or any package manager directly from WSL.** Running `uv run`, `uv sync`, `uv pip`, `bun install`, etc. from WSL will create a Linux `.venv`/`node_modules` that **destroys the Windows environment** and breaks the running server.
2. **ALWAYS use PowerShell** for any command that touches runtime, dependencies, or builds:
   ```bash
   /mnt/c/Program\ Files/PowerShell/7/pwsh.exe -NoProfile -Command "<command>"
   ```
3. **Safe from WSL:** Reading/writing source files, `git` operations, searching code (grep/rg/find). These do not touch the runtime environment.
4. **Unsafe from WSL (MUST use PowerShell):** `uv run`, `uv sync`, `uv pip`, `uv add`, `pytest`, `bun run`, `bun install`, `npm install`, `pip install`, or ANY command that reads/writes `.venv`, `node_modules`, or produces platform-specific artifacts.

### Why this matters

The `.venv` and `node_modules` directories contain Windows-specific binaries (`.dll`, `.exe`, `.pyd`). Running `uv sync` or `bun install` from WSL replaces them with Linux binaries, silently breaking the Windows runtime. If a server is running, it will crash on the next operation that touches a replaced file.

## Project Overview

Murmur is a desktop voice transcription app with two components:
- **app/** - Electron frontend (Svelte 5, TypeScript, Tailwind CSS v4)
- **server/** - Python backend (FastAPI, faster-whisper)

Communication between them uses a custom WebSocket protocol on port 51717 (documented in `docs/protocol.md`).

## Commands

### App (Electron) - uses `bun`

Commands must run on Windows (PowerShell), not WSL:
```bash
/mnt/c/Program\ Files/PowerShell/7/pwsh.exe -NoProfile -Command "cd C:\Users\raikr\Documents\projs\murmur\nemotron\app; bun run dev"
```

### Server (Python) - uses `uv` and `just`

Commands must run on Windows (PowerShell), not WSL:
```bash
# Use just (which internally runs via PowerShell):
just start      # Start server (foreground)
just start-bg   # Start server (background)
just stop       # Stop server (kills port 51717)
just status     # Check if server is running
just test       # Run pytest

# Or use PowerShell directly:
/mnt/c/Program\ Files/PowerShell/7/pwsh.exe -NoProfile -Command "cd C:\Users\raikr\Documents\projs\murmur\nemotron\server; uv run python -m main"
/mnt/c/Program\ Files/PowerShell/7/pwsh.exe -NoProfile -Command "cd C:\Users\raikr\Documents\projs\murmur\nemotron\server; uv run pytest"
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
| Logger | `app/src/main/lib/logger.ts` |

## Logging (Main Process)

Use the structured logger for all main process logging. Never use `console.log/warn/error` directly.

```typescript
import { createLogger } from '../lib/logger.js';
const log = createLogger('ModuleName');

log.trace('Very noisy details', { data });     // MURMUR_TRACE=1 to enable
log.debug('Development info', { data });       // MURMUR_DEBUG=1 to enable
log.info('Notable event', { data });           // Always shown
log.warn('Something unexpected', { data });    // Always shown
log.error('Failure', { error });               // Always shown
```

**Guidelines:**
- Create one logger per module with a descriptive context name
- Use structured data objects, not string interpolation: `log.info('Connecting', { url })` not `log.info(\`Connecting to ${url}\`)`
- Pass `Error` objects directly: `log.error('Failed', { error })` - stack traces are formatted automatically
- Use appropriate levels:
  - `trace`: Internal state, loop iterations, very frequent events
  - `debug`: Useful for development, input/output of functions
  - `info`: Lifecycle events, user actions, notable state changes
  - `warn`: Recoverable issues, unexpected but handled conditions
  - `error`: Failures that affect functionality

**Output format** (slog-style):
```
[2024-01-15 14:32:07] INFO  [Clipboard] Writing text length=12 text="Hello world"
[2024-01-15 14:32:09] ERROR [Hotkey] Registration failed error="Access denied"
    at registerHotkey (hotkey.ts:45)
```

## Build Configuration

- Vite config: `app/vite.config.ts` (multi-entry: overlay + app)
- Main process build: `app/scripts/build-main.js` (esbuild)
- TypeScript: `tsconfig.json` (renderer), `tsconfig.main.json` (main process)

## Important Guidelines

- **Never fake or approximate assets** - When using images, icons, or other assets, always use the actual files. Never create SVG approximations or recreate assets from scratch. If there are path/access issues, ask about the best way to resolve them.
- **Ask when there are multiple approaches** - When a task has multiple valid solutions and the "right" choice isn't obvious, ask which approach is preferred rather than picking one arbitrarily.
