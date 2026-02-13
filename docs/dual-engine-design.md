# Dual-Engine Architecture & Settings System

## Overview

Murmur is pivoting to **Nemotron Speech** as its primary transcription engine. Nemotron provides true streaming with constant ~44ms latency — a fundamental improvement over the re-transcribe approach. Faster-whisper remains as a legacy/alternative engine for users who need multilingual support or have constrained VRAM.

This document designs the full stack: engine abstraction, settings system, protocol changes, and client UI.

**Goals:**
- Abstract over Nemotron and faster-whisper behind a common interface
- **Nemotron is the default** — README, docs, and UI should lead with Nemotron
- All engine/transcription settings readable and writable at runtime via REST API
- Protocol extended so sessions know what engine they're using
- Electron app gets an "Engine" settings section with advanced options
- Hot-swap engines between sessions without restarting the server

**Non-goals:**
- Simultaneous use of both engines in one session
- Per-session engine override (engine is server-wide, not per-session)
- Mid-session engine switching

---

## 1. Engine Abstraction Layer

> Builds on the existing `docs/engine-abstraction-spec.md`. Key updates: Nemotron is default, chunk_ms defaults to 160ms.

### 1.1 Core Interfaces

```
server/src/transcription/
  base.py          # Protocols: TranscriptionEngine, EngineSession, AudioMode
  types.py         # TranscribeResult dataclass
  factory.py       # Engine creation, discovery, hot-swap
  processor.py     # TranscriptionProcessor (updated for both modes)
  engines/
    whisper.py     # WhisperEngine + WhisperSession
    nemotron.py    # NemotronEngine + NemotronSession
```

Two key abstractions:

**TranscriptionEngine** (singleton per engine type) — loads the model, creates sessions:

```python
class TranscriptionEngine(Protocol):
    @property
    def audio_mode(self) -> AudioMode: ...    # FULL_BUFFER or INCREMENTAL
    @property
    def engine_info(self) -> EngineInfo: ...   # Metadata for client
    def create_session(self) -> EngineSession: ...
    def shutdown(self) -> None: ...
```

**EngineSession** (per WebSocket connection) — owns streaming state:

```python
class EngineSession(Protocol):
    def transcribe(self, audio: NDArray[np.float32], *, hotwords: str | None = None) -> TranscribeResult: ...
    def finalize(self) -> TranscribeResult: ...
    def close(self) -> None: ...
```

**AudioMode** determines what audio gets fed:

```python
class AudioMode(StrEnum):
    FULL_BUFFER = auto()   # Whisper: re-transcribes entire buffer each call
    INCREMENTAL = auto()   # Nemotron: processes only new audio chunk
```

### 1.2 EngineInfo (new)

Each engine exposes metadata the client can display:

```python
@dataclass(frozen=True)
class EngineInfo:
    """Engine metadata exposed to the client."""
    id: str                    # "nemotron" or "whisper"
    name: str                  # "Nemotron Speech" or "Faster-Whisper"
    model: str                 # "nvidia/nemotron-speech-streaming-en-0.6b" or "large-v3-turbo"
    mode: str                  # "streaming" or "batch-retranscribe"
    supports_hotwords: bool    # Whisper: yes, Nemotron: no (currently)
    languages: list[str]       # ["en"] or ["en", "de", "fr", ...]
    chunk_ms: int | None       # Nemotron: 160, Whisper: None
    model_size_gb: float       # Model weights on disk/in memory (Nemotron: ~2.3 GB, Whisper turbo: ~1.5 GB)
```

### 1.3 AudioBuffer Cursor

For incremental engines, `AudioBuffer` gets a cursor:

```python
class AudioBuffer:
    _cursor: int = 0  # Sample offset for incremental reads

    def get_new_audio_float32(self) -> NDArray[np.float32]:
        """Audio since last call. Advances cursor. Used by INCREMENTAL engines."""
        all_audio = self.get_audio()
        new = all_audio[self._cursor:]
        self._cursor = len(all_audio)
        return new.astype(np.float32) / 32768.0
```

### 1.4 Processor Changes

`TranscriptionProcessor` becomes audio-mode aware:

```python
class TranscriptionProcessor:
    def __init__(self, context):
        engine = get_engine()
        self._session = engine.create_session()   # Per-connection GPU state
        self._audio_mode = engine.audio_mode

    async def transcribe_partial(self):
        if self._audio_mode == AudioMode.FULL_BUFFER:
            audio = self._context.audio_buffer.get_audio_float32()
        else:
            audio = self._context.audio_buffer.get_new_audio_float32()
        # ... run in executor, return result

    async def transcribe_final(self):
        if self._audio_mode == AudioMode.FULL_BUFFER:
            audio = self._context.audio_buffer.get_audio_float32()
            return await self._run(lambda: self._session.transcribe(audio))
        else:
            return await self._run(self._session.finalize)

    def close(self):
        self._session.close()  # Release GPU cache tensors
```

---

## 2. Settings System

### 2.1 Design Principle

Settings live in one place: **the server's `Settings` class** (pydantic-settings). The Electron app reads/writes them via REST API. No duplication.

```
                    ┌─────────────┐
                    │ electron-   │  App settings (hotkey, autoPaste, etc.)
                    │ store       │  These stay client-only
                    └─────────────┘
                          │
  ┌───────────────────────┼───────────────────────┐
  │            Electron Main Process              │
  │                                               │
  │   SettingsView ←→ IPC ←→ settings.ts          │
  │                         ↕ REST                │
  │                    GET/PATCH /settings         │
  └───────────────────────┼───────────────────────┘
                          │ HTTP
                    ┌─────┴─────────┐
                    │  FastAPI      │
                    │  /settings    │  Server settings (engine, model, etc.)
                    │  /engines     │  Engine discovery
                    └───────────────┘
```

**Split:**
- **Client-only settings** (electron-store): hotkey, holdToTalk, selectedDeviceId, appendPeriod, appendSpace, autoCopy, autoPaste, launchOnBoot, startMinimized, serverUrl — these don't affect the server
- **Server settings** (REST API): engine, model, chunk_ms, compute_type, device, partial_emission_interval, silence behavior — these affect transcription

The `start` frame already carries per-session overrides (silence_timeout, hotwords, partial_emission_interval). That stays. The new REST API controls the *server-wide* settings that apply across all sessions.

### 2.2 Server Settings Schema

```python
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MURMUR_", env_file=".env")

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 51717
    max_sessions: int = 10
    start_timeout: float = 10.0

    # --- Engine selection ---
    engine: Literal["nemotron", "whisper"] = "nemotron"   # Nemotron is default

    # --- Whisper settings ---
    whisper_model: str = "large-v3-turbo"
    whisper_device: Literal["auto", "cpu", "cuda"] = "auto"
    whisper_compute_type: Literal["auto", "int8", "int8_float16", "int16", "float16", "float32"] = "auto"

    # --- Nemotron settings ---
    nemotron_model: str = "nvidia/nemotron-speech-streaming-en-0.6b"
    nemotron_chunk_ms: Literal[160, 560, 1120] = 160     # 160ms = best quality + fastest updates
    nemotron_device: Literal["auto", "cpu", "cuda"] = "auto"

    # --- Transcription behavior ---
    partial_emission_interval: float = 0.25
    min_audio_for_transcription: float = 0.5

    # --- Logging ---
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_binary: bool = False
```

### 2.3 Settings Metadata

For the client to render settings dynamically, the server describes each setting with metadata:

```python
@dataclass
class SettingMeta:
    key: str
    value: Any
    label: str
    description: str
    type: Literal["select", "number", "bool", "text"]
    options: list[Any] | None = None          # For select type
    range: tuple[float, float] | None = None  # For number type
    requires_reload: bool = False              # Engine reload needed?
    category: str = "general"                  # For UI grouping
    visible_when: dict[str, Any] | None = None # Conditional visibility
    readonly: bool = False                     # Computed/status fields
```

Example metadata response:

```json
{
  "engine": {
    "value": "nemotron",
    "label": "Transcription Engine",
    "description": "The speech recognition engine to use",
    "type": "select",
    "options": [
      { "value": "nemotron", "label": "Nemotron Speech", "description": "True streaming, constant 44ms latency. English. ~2.3 GB model." },
      { "value": "whisper", "label": "Faster-Whisper", "description": "Legacy re-transcribe mode. 25+ languages. ~1.5 GB model." }
    ],
    "requires_reload": true,
    "category": "engine"
  },
  "nemotron_chunk_ms": {
    "value": 160,
    "label": "Chunk Size",
    "description": "Audio chunk size for streaming. Smaller = more frequent updates. 160ms recommended.",
    "type": "select",
    "options": [
      { "value": 160, "label": "160ms", "description": "Best quality, 6 updates/sec (recommended)" },
      { "value": 560, "label": "560ms", "description": "Fewer updates, 2/sec" },
      { "value": 1120, "label": "1120ms", "description": "Fewest updates, ~1/sec" }
    ],
    "requires_reload": true,
    "category": "engine",
    "visible_when": { "engine": "nemotron" }
  },
  "whisper_model": {
    "value": "large-v3-turbo",
    "label": "Whisper Model",
    "description": "Model size. Larger = better quality, more VRAM.",
    "type": "select",
    "options": [
      { "value": "large-v3-turbo", "label": "Large V3 Turbo", "description": "Best speed/quality balance (~1.5 GB model)" },
      { "value": "large-v3", "label": "Large V3", "description": "Highest quality, slower" },
      { "value": "medium", "label": "Medium", "description": "~1.4 GB model" },
      { "value": "small", "label": "Small", "description": "~0.5 GB model" },
      { "value": "tiny", "label": "Tiny", "description": "Fastest, lowest quality" }
    ],
    "requires_reload": true,
    "category": "engine",
    "visible_when": { "engine": "whisper" }
  },
  "whisper_compute_type": {
    "value": "auto",
    "label": "Compute Precision",
    "description": "Lower precision = faster + less VRAM but slightly lower quality",
    "type": "select",
    "options": [
      { "value": "auto", "label": "Auto (recommended)" },
      { "value": "float16", "label": "Float16" },
      { "value": "int8_float16", "label": "Int8+Float16" },
      { "value": "int8", "label": "Int8" },
      { "value": "float32", "label": "Float32" }
    ],
    "requires_reload": true,
    "category": "engine",
    "visible_when": { "engine": "whisper" }
  },
  "partial_emission_interval": {
    "value": 0.25,
    "label": "Update Interval",
    "description": "How often partial transcription results are sent (seconds)",
    "type": "number",
    "range": [0.1, 2.0],
    "requires_reload": false,
    "category": "transcription"
  }
}
```

---

## 3. REST API

### 3.1 Endpoints

All new endpoints on the existing FastAPI server (port 51717):

#### `GET /settings`

Returns all server settings with metadata.

```
GET /settings
```

Response:

```json
{
  "settings": {
    "engine": { "value": "nemotron", "label": "...", ... },
    "nemotron_chunk_ms": { "value": 160, ... },
    ...
  },
  "engine_status": {
    "current": "nemotron",
    "status": "ready",
    "info": {
      "id": "nemotron",
      "name": "Nemotron Speech",
      "model": "nvidia/nemotron-speech-streaming-en-0.6b",
      "mode": "streaming",
      "supports_hotwords": false,
      "languages": ["en"],
      "chunk_ms": 160,
      "model_size_gb": 2.3
    }
  },
  "available_engines": ["nemotron", "whisper"]
}
```

#### `PATCH /settings`

Update one or more settings. Returns the new state.

```
PATCH /settings
Content-Type: application/json

{
  "engine": "whisper",
  "whisper_model": "large-v3-turbo"
}
```

Response:

```json
{
  "settings": { ... },
  "engine_status": {
    "current": "whisper",
    "status": "loading",
    "message": "Loading Whisper model: large-v3-turbo..."
  },
  "reload_required": true,
  "reload_started": true
}
```

If `reload_required` is true and there are active sessions:

```json
{
  "settings": { ... },
  "engine_status": {
    "current": "nemotron",
    "status": "ready",
    "pending": {
      "engine": "whisper",
      "status": "loading"
    }
  },
  "reload_required": true,
  "reload_started": true,
  "active_sessions": 1,
  "note": "New engine loading in background. Active sessions will finish with current engine."
}
```

#### `GET /engines`

Discover which engines are available (dependencies installed).

```
GET /engines
```

Response:

```json
{
  "engines": [
    {
      "id": "nemotron",
      "name": "Nemotron Speech",
      "available": true,
      "description": "True streaming with constant ~44ms latency. English only.",
      "model_size_gb": 2.3,
      "languages": ["en"],
      "features": ["true_streaming", "constant_latency"]
    },
    {
      "id": "whisper",
      "name": "Faster-Whisper",
      "available": true,
      "description": "Legacy re-transcribe mode. 25+ languages.",
      "model_size_gb": 1.5,
      "languages": ["en", "de", "fr", "es", "..."],
      "features": ["multilingual", "hotwords"]
    }
  ],
  "current": "nemotron"
}
```

If an engine's dependencies aren't installed, `available: false` with:

```json
{
  "id": "nemotron",
  "available": false,
  "install_hint": "uv sync --extra nemotron"
}
```

#### `GET /engine/status`

Lightweight poll for engine loading state (used during hot-swap).

```
GET /engine/status
```

Response:

```json
{
  "current": "nemotron",
  "status": "ready",
  "info": { ... }
}
```

Or during a swap:

```json
{
  "current": "nemotron",
  "status": "ready",
  "pending": {
    "engine": "whisper",
    "status": "loading",
    "message": "Loading model large-v3-turbo...",
    "progress": null
  }
}
```

### 3.2 Settings Persistence

Server settings are persisted to `server/settings.json` (JSON, not .env — easier to read/write programmatically). The Electron app already has its own persistence via electron-store; this is purely for server-side settings.

When settings are changed via `PATCH /settings`, the server:
1. Validates the new values
2. Writes them to `server/settings.json`
3. Updates the in-memory `Settings` instance
4. If `requires_reload` settings changed, triggers engine hot-swap

**Priority order** (highest wins):
1. Environment variables (`MURMUR_ENGINE=whisper`) — for deployment/CI overrides
2. `server/settings.json` — runtime user changes
3. Defaults in `Settings` class

**Persistence file** (`server/settings.json`):

```json
{
  "engine": "nemotron",
  "nemotron_chunk_ms": 160
}
```

Only settings that differ from defaults are persisted.

---

## 4. Protocol v2 Changes

### 4.1 Enhanced `ready` Frame

The `ready` frame now includes engine information so the client knows what's handling this session:

```json
{
  "frame": "control",
  "type": "ready",
  "engine": {
    "id": "nemotron",
    "name": "Nemotron Speech",
    "model": "nvidia/nemotron-speech-streaming-en-0.6b",
    "mode": "streaming",
    "supports_hotwords": false,
    "chunk_ms": 160
  }
}
```

This is backward-compatible: v1 clients ignore the new `engine` field (per the protocol's extensibility rules: "Unknown fields: ignore silently").

### 4.2 Enhanced `partial` Frame (optional)

For Nemotron's streaming mode, partials can include a `latency_ms` field:

```json
{
  "frame": "text",
  "type": "partial",
  "text": "hello how are you",
  "confidence": 0.9,
  "transcription_time": 0.044,
  "audio_duration": 2.5,
  "latency_ms": 44
}
```

Again, backward-compatible. v1 clients ignore the extra field.

### 4.3 No New Control Frame Types

Settings management is handled entirely via REST API, not the WebSocket protocol. The WebSocket remains focused on audio streaming. This is cleaner because:
- Settings are request/response (REST is natural)
- WebSocket is streaming (audio + transcription)
- No mixing of concerns
- Client can manage settings without an active transcription session

### 4.4 `start` Frame (unchanged)

The `start` frame already carries per-session parameters:

```json
{
  "frame": "control",
  "type": "start",
  "silence_timeout": 5,
  "partial_emission_interval": 0.2,
  "hotwords": "Kubernetes, Svelte"
}
```

`hotwords` is only effective when the current engine supports it (Whisper: yes, Nemotron: no). The `ready` frame's `engine.supports_hotwords` field tells the client whether to show the hotwords option.

---

## 5. Engine Hot-Swap

### 5.1 How It Works

When the user changes the engine via `PATCH /settings`:

```
1. Server receives PATCH {engine: "whisper"}
2. Server immediately responds with {reload_started: true}
3. Background task starts loading WhisperEngine
4. During loading:
   - GET /engine/status returns {pending: {status: "loading"}}
   - Existing sessions continue with NemotronEngine
   - New sessions also use NemotronEngine (until swap completes)
5. When WhisperEngine is ready:
   - Swap: new sessions get WhisperEngine
   - Old NemotronEngine stays alive until all its sessions end
   - Then NemotronEngine.shutdown() releases GPU memory
6. GET /engine/status returns {status: "ready", current: "whisper"}
```

### 5.2 Server-Side Implementation

```python
# factory.py - conceptual

class EngineManager:
    """Manages engine lifecycle with hot-swap support."""

    _current_engine: TranscriptionEngine
    _pending_engine: TranscriptionEngine | None = None
    _active_sessions: dict[str, TranscriptionEngine]  # session_id -> engine used

    async def swap_engine(self, new_settings: Settings) -> None:
        """Load a new engine in the background and swap when ready."""
        self._pending_status = "loading"

        # Load in thread pool (blocking I/O)
        loop = asyncio.get_running_loop()
        new_engine = await loop.run_in_executor(
            None, lambda: _create_engine(new_settings)
        )

        # Swap
        old_engine = self._current_engine
        self._current_engine = new_engine
        self._pending_engine = None

        # Old engine cleanup: wait for sessions to finish, then shutdown
        # (tracked via _active_sessions)

    def create_session(self, session_id: str) -> EngineSession:
        """Create session and track which engine it uses."""
        session = self._current_engine.create_session()
        self._active_sessions[session_id] = self._current_engine
        return session

    def release_session(self, session_id: str) -> None:
        """Release session. If engine is retired and no more sessions, shut it down."""
        engine = self._active_sessions.pop(session_id, None)
        if engine is not None and engine is not self._current_engine:
            # Check if this was the last session on the old engine
            if engine not in self._active_sessions.values():
                engine.shutdown()
```

### 5.3 VRAM During Hot-Swap

During a swap, briefly both models are in GPU memory. Actual model sizes:

| Model | On-Disk / Weight Size |
|-------|----------------------|
| Nemotron 0.6b | ~2.3 GB |
| Whisper large-v3-turbo | ~1.5 GB |
| **Both loaded** | **~3.8 GB** |

Both fit easily on any modern GPU (8 GB+). **By default, both are loaded simultaneously** during the swap for a seamless transition.

For users with very constrained VRAM, an advanced setting `unload_before_swap` (default: `false`) forces the old engine to unload before the new one loads. This causes a brief gap where no engine is available, but frees the maximum VRAM.

### 5.4 Fallback Behavior

On startup, if the configured engine isn't available:

```
1. Try loading configured engine (default: "nemotron")
2. If ImportError (nemo_toolkit not installed):
   a. Log warning: "Nemotron not available, falling back to Whisper"
   b. Try loading "whisper"
   c. If also fails → fatal error
3. Update in-memory settings to reflect actual engine
4. GET /settings response shows actual state
```

---

## 6. Electron App Changes

### 6.1 New Settings Categories

The Settings UI gets reorganized:

```
Settings View
├── Activation         (existing - hotkey, hold-to-talk)
├── Audio              (existing - input device)
├── Post-Processing    (existing - append period/space)
├── Behavior           (existing - auto-copy/paste, launch on boot)
├── Recognition        (existing - hotwords)
├── Engine             (NEW - engine selection, model settings)
└── About              (existing - version)
```

### 6.2 Engine Settings Section

The new "Engine" section reads its options from `GET /settings` and renders dynamically based on the metadata:

```
┌─ Engine ─────────────────────────────────────────────────────┐
│                                                               │
│  Transcription Engine                                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ● Nemotron Speech                                       │ │
│  │   True streaming, constant 44ms latency (English only)  │ │
│  │                                                         │ │
│  │ ○ Faster-Whisper                                        │ │
│  │   Legacy re-transcribe mode, 25+ languages              │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  Chunk Size                          [160ms (recommended) ▾]  │
│  Audio chunk size for streaming                               │
│                                                               │
│  ── Advanced ──────────────────────────── [expand/collapse]   │
│                                                               │
│  Model      [nvidia/nemotron-speech-streaming-en-0.6b]        │
│  Device     [Auto ▾]                                          │
│                                                               │
│  ⚡ Changes require engine reload                              │
│  [Apply & Reload Engine]                                      │
│                                                               │
│  Status: ● Ready                                              │
│  Model size: ~2.3 GB                                          │
│                                                               │
│  ── Advanced ──────────────────────────── [expand/collapse]   │
│                                                               │
│  Unload before swap     [ ] (default off)                     │
│  (Free VRAM before loading new engine — for low-VRAM GPUs)    │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

When Whisper is selected, the section changes:

```
┌─ Engine ─────────────────────────────────────────────────────┐
│                                                               │
│  Transcription Engine                                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ○ Nemotron Speech                                       │ │
│  │ ● Faster-Whisper                                        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  Model                               [Large V3 Turbo ▾]      │
│  Compute Precision                   [Auto ▾]                 │
│                                                               │
│  ⚡ Changes require engine reload                              │
│  [Apply & Reload Engine]                                      │
│                                                               │
│  Status: ● Ready                                              │
│  Model size: ~1.5 GB                                          │
│                                                               │
│  ── Advanced ──────────────────────────── [expand/collapse]   │
│                                                               │
│  Device     [Auto ▾]                                          │
│  Unload before swap     [ ]                                   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 6.3 Engine Status Indicator

The overlay or tray could show a subtle engine indicator:

```
🎤 Nemotron · 44ms     (during transcription)
🎤 Whisper · 230ms     (during transcription)
```

And in the status bar of the main window:

```
Engine: Nemotron Speech · Ready · ~2.3 GB
```

### 6.4 Conditional Hotwords

Since Nemotron doesn't support hotwords, the Recognition section should be aware:

```
┌─ Recognition ────────────────────────────────────────────────┐
│                                                               │
│  ⓘ Hotwords are not supported by the Nemotron engine.        │
│    Switch to Faster-Whisper to use hotwords.                  │
│                                                               │
│  [Enable Hotwords]  (disabled/grayed out)                     │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 6.5 Client-Side Data Flow

```
SettingsView.svelte
    │
    │ on:mount → fetch GET /settings
    │ on:change → PATCH /settings (debounced)
    │ on:apply-reload → PATCH /settings + poll GET /engine/status
    │
    ▼
settings-api.ts (new module in Electron main process)
    │
    │ getServerSettings(): Promise<ServerSettings>
    │ updateServerSettings(patch): Promise<ServerSettings>
    │ getEngineStatus(): Promise<EngineStatus>
    │ getAvailableEngines(): Promise<Engine[]>
    │
    ▼
HTTP to server (localhost:51717)
```

New IPC channels:

```typescript
// constants.ts additions
GET_SERVER_SETTINGS: 'server:get-settings'
UPDATE_SERVER_SETTINGS: 'server:update-settings'
GET_ENGINE_STATUS: 'server:engine-status'
GET_AVAILABLE_ENGINES: 'server:engines'
```

### 6.6 Settings Type Updates

```typescript
// shared/types.ts additions

interface ServerSettings {
  engine: ServerSetting<'nemotron' | 'whisper'>
  nemotron_chunk_ms: ServerSetting<160 | 560 | 1120>
  nemotron_model: ServerSetting<string>
  nemotron_device: ServerSetting<string>
  whisper_model: ServerSetting<string>
  whisper_compute_type: ServerSetting<string>
  whisper_device: ServerSetting<string>
  partial_emission_interval: ServerSetting<number>
}

interface ServerSetting<T> {
  value: T
  label: string
  description: string
  type: 'select' | 'number' | 'bool' | 'text'
  options?: Array<{ value: T; label: string; description?: string }>
  range?: [number, number]
  requires_reload: boolean
  category: string
  visible_when?: Record<string, unknown>
  readonly?: boolean
}

interface EngineInfo {
  id: string
  name: string
  model: string
  mode: 'streaming' | 'batch-retranscribe'
  supports_hotwords: boolean
  languages: string[]
  chunk_ms: number | null
  model_size_gb: number
}

interface EngineStatus {
  current: string
  status: 'loading' | 'ready' | 'error'
  info?: EngineInfo
  pending?: {
    engine: string
    status: 'loading' | 'ready' | 'error'
    message?: string
  }
}
```

---

## 7. Dependency Management

### 7.1 Optional Dependency Groups

```toml
[project]
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "pydantic>=2.10.0",
    "pydantic-settings>=2.6.0",
    "numpy>=1.26.0",
    "soundfile>=0.12.0",
]

[project.optional-dependencies]
whisper = ["faster-whisper>=1.1.0"]
nemotron = ["nemo_toolkit[asr]>=2.2.0"]
all = ["murmur-server[whisper,nemotron]"]
```

Install commands:

```bash
uv sync --extra nemotron         # Nemotron only (default engine)
uv sync --extra whisper          # Whisper only
uv sync --extra all              # Both engines
```

### 7.2 Engine Discovery

At startup, the server probes which engines are installable:

```python
def discover_engines() -> list[str]:
    available = []
    try:
        import faster_whisper
        available.append("whisper")
    except ImportError:
        pass
    try:
        import nemo.collections.asr
        available.append("nemotron")
    except ImportError:
        pass
    return available
```

This powers `GET /engines` and the fallback logic.

---

## 8. Migration Path

### Phase 1: Engine Abstraction (no new features, no behavior change)

Refactor the server to use the abstract engine interface. Default stays Whisper during this phase (no risk). All existing tests pass.

1. Create `base.py`, `types.py` with protocols
2. Move `WhisperEngine` to `engines/whisper.py`, adapt to protocol
3. Create `factory.py` with `get_engine()` and engine discovery
4. Add `AudioBuffer.get_new_audio_float32()` with cursor
5. Update `TranscriptionProcessor` for `AudioMode`
6. Add `processor.close()` to handler cleanup
7. Add `engine` setting to `Settings` (default `"whisper"` for now)

### Phase 2: Settings REST API

Add the REST endpoints for reading/writing settings.

1. Add `GET /settings` with metadata
2. Add `PATCH /settings` with validation
3. Add `GET /engines` for discovery
4. Add settings persistence (`settings.json`)
5. Update `GET /health` to include engine info

### Phase 3: Nemotron Engine + Default Switch

Implement the `NemotronEngine` based on PoC code. **This is the pivot point** — Nemotron becomes the default.

1. Create `engines/nemotron.py` (port from `poc/nemotron/transcribe_streaming.py`)
2. Add `nemotron` optional dependency group
3. Implement `NemotronSession` with cache management
4. **Change default engine to `"nemotron"`**
5. Test with real audio
6. Update README to lead with Nemotron (Whisper documented as alternative)
7. Update project description / branding

### Phase 4: Hot-Swap

Enable runtime engine switching.

1. Implement `EngineManager` with swap logic
2. Background loading with status tracking
3. Add `GET /engine/status` endpoint
4. Session-to-engine tracking for graceful cleanup

### Phase 5: Electron UI

Build the client-side settings experience.

1. Add settings API module (HTTP client)
2. Add new IPC channels for server settings
3. Build Engine section in SettingsView
4. Add engine status indicator
5. Conditional hotwords visibility
6. Loading state during engine swap

---

## 9. Design Decisions (Resolved)

1. **Settings persistence**: `server/settings.json` (JSON). Easy to read/write programmatically. Environment variables override for deployment/CI. The Electron app has its own persistence (electron-store) — no duplication.

2. **Engine swap during active session**: No force-stop. Existing sessions finish with their current engine. New sessions get the new engine once it's loaded. Simple and safe.

3. **VRAM during hot-swap**: Both models fit easily — Nemotron (~2.3 GB) + Whisper turbo (~1.5 GB) = ~3.8 GB of model weights. By default, both are loaded simultaneously during swap. An advanced setting (`unload_before_swap`) lets VRAM-constrained users force sequential loading.

4. **Nemotron hotwords**: Just show a clear notice "Hotwords not supported with Nemotron engine" in the UI. Disable the hotwords controls. No post-processing workaround.

5. **Default engine**: Nemotron. Period. This is a deliberate pivot — README, docs, UI all lead with Nemotron. Whisper is documented as a legacy/alternative for multilingual needs.

---

## 10. Summary

| Aspect | Current | Proposed |
|--------|---------|----------|
| **Engine** | Whisper only, hardcoded | Abstracted, **Nemotron default** |
| **Branding** | Whisper-centric | Nemotron-first (Whisper = legacy alternative) |
| **Settings** | Env vars only, no runtime changes | REST API + `settings.json` persistence |
| **Protocol** | No engine awareness | `ready` frame includes engine info |
| **Engine switch** | Requires restart | Hot-swap between sessions |
| **UI** | No engine settings | Engine section with advanced options |
| **Dependencies** | All required | Optional groups per engine |
| **Hotwords** | Always available | Conditional on engine support (notice when disabled) |
| **VRAM** | ~1.5 GB (Whisper turbo) | ~2.3 GB (Nemotron) / ~3.8 GB (both) |
