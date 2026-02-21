<p align="center">
  <img src="app/resources/icon.png" alt="Murmur" width="128" height="128">
</p>

<h1 align="center">Murmur</h1>

<p align="center">
  <strong>Local voice transcription for Windows</strong><br>
  Press a key, speak, release - your text appears where you are typing.
</p>

---

> [!CAUTION]
> Murmur is alpha software. Core workflows are usable, but expect rough edges and rapid iteration.

## What Murmur Is

Murmur is a desktop dictation app that runs entirely on your machine:

- `app/`: Electron desktop app (overlay, settings, history, server controls)
- `server/`: FastAPI WebSocket transcription server (Nemotron + Whisper engines)

No cloud API is required for local usage.

## Current Feature Set

- Global hotkey recording (`hold-to-talk` and `toggle` modes)
- Pre-warmed transparent overlay with live partial text and waveform
- Local post-processing (`append period`, `append space`)
- Clipboard + auto-paste output pipeline
- Local searchable history (SQLite)
- Two engine options with hot-swap:
  - `nemotron` (default, English-focused, low-latency)
  - `whisper` (multilingual, hotwords supported)
- Runtime server controls in-app (status, start/stop/restart, log streaming)
- External server mode (custom host/port in Settings)

## Repository Layout

```text
app/      Electron app (Svelte 5 + TypeScript + Tailwind)
server/   FastAPI transcription backend (Python 3.11+)
docs/     Protocol and technical notes
.dev/     Active internal scratch notes
```

## Development Setup

### 1) Prerequisites

- Windows 10/11
- Bun
- Python 3.11+
- uv
- just
- CUDA-capable GPU recommended (CPU is supported, but slower)

### 2) Important WSL Safety Note

If you work from WSL, run dependency/runtime commands through Windows PowerShell.
Do **not** run `uv sync`, `uv run`, `bun install`, or `bun run` directly in Linux mode against this repo.

### 3) Install server dependencies

From `server/` (PowerShell on Windows):

```powershell
# Install both engines (recommended)
uv sync --extra all
```

Engine-specific installs:

```powershell
uv sync --extra nemotron
uv sync --extra whisper
```

### 4) Start server (dev)

From `server/`:

```bash
just start
```

Other useful commands:

```bash
just start-bg
just status
just stop
just test
```

### 5) Start app (dev)

From `app/` (PowerShell on Windows):

```powershell
bun install
bun run dev
```

In development, Murmur **detects** an already-running server; it does not auto-spawn one.

## Build / Package

Build Windows installer:

```powershell
# ensure server .venv is current first
cd server
uv sync --extra all

cd ../app
bun run package:win
```

Root-level helper:

```bash
just build
```

See `BUILDING.md` for full release and troubleshooting details.

## Configuration

### App settings (UI)

Configured in `Settings` view:

- Hotkey / activation mode
- Audio input device
- Post-processing options
- Auto-copy / auto-paste
- Startup behavior
- Engine settings (fetched from server REST API)
- External server toggle and endpoint

### Server environment variables

All settings use `MURMUR_` prefix.

| Variable | Default | Description |
|---|---|---|
| `MURMUR_HOST` | `0.0.0.0` | Bind host |
| `MURMUR_PORT` | `51717` | Bind port (`0` allows random OS-assigned port) |
| `MURMUR_MAX_SESSIONS` | `10` | Concurrent session cap |
| `MURMUR_START_TIMEOUT` | `10.0` | Seconds to wait for `start` frame |
| `MURMUR_ENGINE` | `nemotron` | Default engine (`nemotron` or `whisper`) |
| `MURMUR_NEMOTRON_MODEL` | `nvidia/nemotron-speech-streaming-en-0.6b` | Nemotron model |
| `MURMUR_NEMOTRON_DEVICE` | `auto` | Nemotron device (`auto`/`cuda`/`cpu`) |
| `MURMUR_WHISPER_MODEL` | `large-v3-turbo` | Whisper model |
| `MURMUR_WHISPER_DEVICE` | `auto` | Whisper device (`auto`/`cuda`/`cpu`) |
| `MURMUR_WHISPER_COMPUTE_TYPE` | `auto` | Whisper precision mode |
| `MURMUR_PARTIAL_EMISSION_INTERVAL` | `0.25` | Minimum partial emission interval (seconds) |
| `MURMUR_MIN_AUDIO_FOR_TRANSCRIPTION` | `0.15` | Minimum audio duration for partial processing |
| `MURMUR_UNLOAD_BEFORE_SWAP` | `false` | Free VRAM before engine swap |
| `MURMUR_LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `MURMUR_LOG_BINARY` | `false` | Verbose protocol logging |

Runtime server settings are also persisted to `server/settings.json` when changed from the app UI.

## Protocol

Murmur uses a custom WebSocket protocol (`/transcribe`) for binary audio + JSON control/text frames.

- Full spec: `docs/protocol.md`

## Docs

- `BUILDING.md`
- `docs/README.md`
- `docs/protocol.md`

## License

[MIT](LICENSE)
