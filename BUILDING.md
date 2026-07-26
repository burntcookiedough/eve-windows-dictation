# Building Eve

Complete guide for setting up, developing, and packaging Eve for Windows.

The repository directory, package name, Python interfaces, and `MURMUR_*`
environment variables remain intentionally stable for compatibility.

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Windows 10/11** | | Target platform |
| **WSL 2** | | Optional development environment |
| **Bun** | 1.0+ | App package manager and runtime |
| **Node.js** | 18+ | Electron tooling |
| **Python** | 3.11+ | Transcription server |
| **uv** | 0.4+ | Python package manager |
| **just** | | Server task runner |
| **PowerShell 7** | | Running Windows commands from WSL |
| **NVIDIA driver** | 525+ | GPU acceleration (optional, CPU works too) |

Install prerequisites (WSL):

```bash
# Bun
curl -fsSL https://bun.sh/install | bash

# uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# just
cargo install just
# or: sudo apt install just
```

---

## Repository Structure

```
murmur/
  app/          Electron desktop client (Svelte 5, TypeScript, Tailwind CSS v4)
  server/       Python transcription server (FastAPI, faster-whisper)
  docs/         Protocol specification
```

---

## Versioning

Use the repo's version script to keep app/server/version badge values in sync.

```bash
# Verify consistency across all managed version files
python scripts/version.py check

# Bump all managed version files together
python scripts/version.py bump 1.0.0
```

Release workflow tags must match the repository version (`vX.Y.Z`).

---

## Release (GitHub Releases)

The release workflow runs only when you push a Git tag matching `v*`.

### Step-by-step (release current version)

Use this when the current repo version is already correct and you do not want to bump.

```bash
# 1) Verify all version surfaces are in sync
python scripts/version.py check

# 2) Read current version from app/package.json
VERSION=$(python -c "import json;print(json.load(open('app/package.json'))['version'])")

# 3) Push trunk first
git push origin trunk

# 4) Tag and push (this triggers .github/workflows/release.yml)
git tag -a "v$VERSION" -m "Release v$VERSION"
git push origin "v$VERSION"
```

### Step-by-step (release with a new version)

Use this when you want to bump before releasing.

```bash
# 1) Bump all managed version files together
python scripts/version.py bump 1.0.0

# 2) Commit version changes
git add app/package.json server/pyproject.toml server/src/version.py README.md
git commit -m "release: prepare v1.0.0"

# 3) Push trunk
git push origin trunk

# 4) Tag and push
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

### What happens after tag push

1. GitHub Actions validates that tag version matches repository version.
2. Workflow builds the Windows nsis-web installer (stub + payloads).
3. Workflow creates/publishes a GitHub Release and uploads release assets.

### If a release run fails

- If it is a transient CI issue, re-run the workflow from GitHub Actions.
- If code changes are needed, fix on `trunk` and release a new patch version/tag.

---

## Development Setup

### 1. Server

The server runs on Windows. Run the Windows build of `just`; recipes resolve the current clone directory and do not depend on a username or fixed checkout path.

```bash
cd server

# Install Python dependencies (all engines, required for packaging)
uv sync --extra all

# Start the server (foreground)
just start

# Or in background
just start-bg

# Check status
just status

# Stop
just stop
```

Optional smaller installs for development:

```bash
uv sync --extra whisper
uv sync --extra nemotron
```

Whisper-only installs do not include PyTorch's CUDA DLLs; GPU mode may be unavailable unless the system has CUDA runtime libraries.

On first run, the server downloads the Whisper model (~1.5 GB for `large-v3-turbo`). This only happens once.

#### Server environment variables

All prefixed with `MURMUR_`. Set them before starting:

```bash
# Example: use CPU instead of GPU
MURMUR_WHISPER_DEVICE=cpu just start

# Example: debug logging
MURMUR_LOG_LEVEL=DEBUG just start
```

| Variable | Default | Description |
|----------|---------|-------------|
| `MURMUR_HOST` | `0.0.0.0` | Bind address |
| `MURMUR_PORT` | `51717` | Server port |
| `MURMUR_WHISPER_MODEL` | `large-v3-turbo` | Whisper model name |
| `MURMUR_WHISPER_DEVICE` | `auto` | `auto`, `cpu`, or `cuda` |
| `MURMUR_WHISPER_COMPUTE_TYPE` | `auto` | `auto`, `int8`, `float16`, `float32` |
| `MURMUR_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `MURMUR_LOG_BINARY` | `false` | Log binary frame details (very verbose) |

#### Running tests

```bash
cd server
just test
```

### 2. App

The Electron app must be built and run on Windows. From WSL, all commands go through PowerShell.

```bash
cd app

# Install dependencies (run from PowerShell or WSL)
bun install
```

#### Running in development

**Start the server first**, then the app:

```bash
# Terminal 1: start the server
cd server
just start

# Terminal 2: start the app
cd app
bun run dev
```

`bun run dev` runs three things concurrently:
1. **Vite dev server** (port 5173) for hot-reloading the renderer
2. **esbuild** in watch mode for the main process
3. **Electron** (waits for Vite to be ready, then launches)

In development mode the app detects the already-running server via a PID file and shows it as "External" in the Server tab. It will **not** try to spawn the server itself.

#### Dev mode features

- DevTools open automatically
- Vite hot module replacement for the renderer (overlay + main window)
- Main process rebuilds on file changes (requires manual Electron restart)

---

## Production Build

### 1. Build the server's virtual environment

The packaged app bundles the Python server with its virtual environment. Make sure the venv is up to date:

```bash
cd server
uv sync --extra all
..\scripts\prepare-python-runtime.ps1 -ServerDir .
```

This creates/updates `server/.venv/` with all Python dependencies and copies uv's managed, python-build-standalone runtime to `server/.runtime/`. The packaged app launches `.runtime/python.exe` with `.venv/Lib/site-packages` on `PYTHONPATH`; it therefore does not depend on Python being installed on the destination laptop.

### 2. Build and package the app

```bash
cd app

# Build renderer (Vite) + main process (esbuild)
bun run build

# Package for Windows (creates nsis-web installer + payloads in app/release/)
bun run package:win
```

This runs electron-builder which:
1. Compiles the renderer and main process into `app/dist/`
2. Copies `server/` (source + `.venv`) into the app's `resources/server/` via `extraResources`
3. Produces an nsis-web installer stub plus payload archives in `app/release/`

The nsis-web installer downloads payloads during install, so an internet connection is required for end users.

### 3. What gets bundled

The `extraResources` config in `app/package.json` copies:

```
server/src/**/*       Python source code
server/.venv/**/*     Virtual environment (Python + all packages)
```

Excluded from the bundle:
- `__pycache__/` directories
- `.pyc` files
- pip/wheel/setuptools packages (not needed at runtime)
- Python/package test suites and interpreter UI/development files
- Static linker archives and PyTorch C++ headers (runtime DLLs remain bundled)

### 4. How the packaged app starts the server

In production (`app.isPackaged === true`), the Electron app:

1. Prefers `{resources}/server/.runtime/python.exe` and uses the bundled `.venv/Lib/site-packages` (with a logged legacy `.venv/Scripts/python.exe` fallback)
2. Spawns it with `{resources}/server/src/main.py`
3. Stores mutable server settings under Electron's per-user data directory, then waits for the server to write a PID file and respond to health checks
4. Begins health polling every 3 seconds

The server writes a PID file to `%APPDATA%/Eve/server.pid` (JSON with `pid`, `port`, `startedAt`) so the app can track it.

### 5. Server lifecycle in production

| Setting | Behavior |
|---------|----------|
| **Auto-start ON** (default) | Server starts automatically when the app launches |
| **Auto-start OFF** | Server must be started manually from the Server tab |
| **App quit** | Server is stopped automatically |
| **Server crash** | Health check detects it, status changes to "Error" |

---

## Build Scripts Reference

### App (`app/`)

| Command | Description |
|---------|-------------|
| `bun run dev` | Development mode (Vite + esbuild watch + Electron) |
| `bun run build` | Production build (renderer + main process) |
| `bun run build:main` | Build main process only (esbuild) |
| `bun run build:renderer` | Build renderer only (Vite) |
| `bun run package:win` | Build + package Windows nsis-web installer + payloads |
| `bun run clear-data` | Clear local app data (settings, history) |

### Server (`server/`)

| Command | Description |
|---------|-------------|
| `just start` | Start server in foreground |
| `just start-bg` | Start server in background |
| `just stop` | Kill server process on port 51717 |
| `just status` | Check if server is running |
| `just test` | Run pytest |

---

## Troubleshooting

### "Cannot find server executable"

This means the app is trying to start the server in production mode but can't find the bundled Python. Causes:

- **Running in dev without the server**: Start the server first with `just start`, then run `bun run dev`
- **Packaged app missing server**: Ensure `uv sync` was run in `server/` before `bun run package:win`

### Server won't start (port in use)

```bash
just stop    # kills whatever is on port 51717
just start   # start fresh
```

### Whisper model download hangs

The model downloads from Hugging Face on first run. If it stalls:

1. Check your internet connection
2. Try setting `HF_HUB_ENABLE_HF_TRANSFER=1` for faster downloads
3. Or manually download the model and point to it with `MURMUR_WHISPER_MODEL=/path/to/model`

### Electron rebuild errors

Native modules (better-sqlite3, uiohook-napi) need to match the Electron version:

```bash
cd app
bun run postinstall   # runs electron-rebuild
```

### GPU not detected

Check the Server view warnings for CUDA DLL, driver, or VC++ Redistributable diagnostics.

```bash
# Check CUDA availability
python -c "import torch; print(torch.cuda.is_available())"

# Force CPU mode if needed
MURMUR_WHISPER_DEVICE=cpu just start
```
