# Engine Abstraction Layer — Technical Specification

## Overview

This spec defines the server-side abstraction that allows Murmur to support multiple transcription backends (faster-whisper, Nemotron Speech, future engines) without changing the WebSocket protocol or client.

The design has two layers:
1. **Engine** — loads a model and creates sessions (singleton, one per process)
2. **EngineSession** — per-connection streaming state (created per WebSocket session, owns any GPU cache)

---

## 1. Core Interfaces

### 1.1 TranscribeResult

A single, engine-agnostic result type used everywhere.

```python
# server/src/transcription/types.py

from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class TranscribeResult:
    """Engine-agnostic transcription result."""

    text: str
    confidence: float            # 0.0–1.0
    last_speech_end: float | None  # Seconds from audio start; None if no speech
```

This replaces the existing `TranscribeResult` in `engine.py`. The `TranscriptionResult` in `processor.py` (which adds timing metadata) stays as-is — it wraps a `TranscribeResult` with `transcription_time`, `audio_duration`, etc.

### 1.2 EngineSession (Protocol)

Per-session interface. Each WebSocket connection gets one. Implementations own any internal state (Whisper: nothing; Nemotron: RNNT cache tensors).

```python
# server/src/transcription/base.py

from typing import Protocol, runtime_checkable
from numpy.typing import NDArray
import numpy as np

from transcription.types import TranscribeResult

@runtime_checkable
class EngineSession(Protocol):
    """Per-session transcription state.

    Implementations must be safe to call from a thread pool executor
    (the async layer calls these in run_in_executor).
    """

    def transcribe(
        self,
        audio: NDArray[np.float32],
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult:
        """Transcribe audio and return the current best hypothesis.

        For batch engines (Whisper): `audio` is the full buffer every call.
        For streaming engines (Nemotron): `audio` is only the new chunk.

        Args:
            audio: Float32 samples normalized to [-1.0, 1.0].
            hotwords: Optional bias phrases.

        Returns:
            Current transcription result.
        """
        ...

    def finalize(self) -> TranscribeResult:
        """Flush any buffered state and return the final result.

        Called once at session end. For batch engines this is a no-op that
        returns the last transcribe() result. For streaming engines this
        flushes the RNNT cache.
        """
        ...

    def close(self) -> None:
        """Release session resources (GPU tensors, caches).

        Called when the WebSocket connection ends. Must be idempotent.
        """
        ...
```

### 1.3 TranscriptionEngine (Protocol)

Singleton model manager. Loads the model once, creates sessions on demand.

```python
# server/src/transcription/base.py (continued)

@runtime_checkable
class TranscriptionEngine(Protocol):
    """Singleton model wrapper that creates per-session state."""

    def create_session(self) -> EngineSession:
        """Create a new per-session instance.

        Called once per WebSocket connection from the async handler.
        Must be fast (no model loading). May allocate GPU cache.
        """
        ...

    def shutdown(self) -> None:
        """Release model resources. Called at process exit."""
        ...
```

### 1.4 AudioMode Enum

Engines declare how they consume audio, so the processor knows what to feed them:

```python
# server/src/transcription/base.py (continued)

from enum import StrEnum, auto

class AudioMode(StrEnum):
    """How an engine session consumes audio."""

    FULL_BUFFER = auto()
    """Re-transcribe the entire buffer each call (Whisper-style)."""

    INCREMENTAL = auto()
    """Process only new audio since last call (streaming-style)."""
```

Each `TranscriptionEngine` exposes an `audio_mode` property:

```python
class TranscriptionEngine(Protocol):
    @property
    def audio_mode(self) -> AudioMode: ...
    def create_session(self) -> EngineSession: ...
    def shutdown(self) -> None: ...
```

---

## 2. Engine Implementations

### 2.1 WhisperEngine (adapter for existing code)

Wraps the current `faster_whisper.WhisperModel`. Minimal changes from existing code.

```python
# server/src/transcription/engines/whisper.py

from faster_whisper import WhisperModel
from transcription.base import AudioMode, EngineSession, TranscriptionEngine
from transcription.types import TranscribeResult

class WhisperEngine:
    """Adapter wrapping faster-whisper as a TranscriptionEngine."""

    audio_mode = AudioMode.FULL_BUFFER

    def __init__(self, model: str, device: str, compute_type: str) -> None:
        self._model = WhisperModel(model, device=device, compute_type=compute_type)

    def create_session(self) -> "WhisperSession":
        return WhisperSession(self._model)

    def shutdown(self) -> None:
        # WhisperModel has no explicit cleanup; dropping the reference suffices
        pass


class WhisperSession:
    """Per-session state for Whisper. Stateless — just holds a model ref."""

    def __init__(self, model: WhisperModel) -> None:
        self._model = model
        self._last_result = TranscribeResult(text="", confidence=0.0, last_speech_end=None)

    def transcribe(
        self,
        audio: NDArray[np.float32],
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult:
        segments, info = self._model.transcribe(
            audio,
            language=None,
            hotwords=hotwords,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )

        text_parts = []
        total_prob = 0.0
        count = 0
        last_end: float | None = None

        for seg in segments:
            text_parts.append(seg.text.strip())
            total_prob += seg.avg_logprob
            count += 1
            last_end = seg.end

        text = " ".join(text_parts).strip()
        confidence = min(1.0, max(0.0, 1.0 + (total_prob / count) / 2.0)) if count else 0.0

        self._last_result = TranscribeResult(
            text=text, confidence=confidence, last_speech_end=last_end,
        )
        return self._last_result

    def finalize(self) -> TranscribeResult:
        # For Whisper, the processor already does a full-buffer transcribe for finals,
        # so finalize just returns the last result.
        return self._last_result

    def close(self) -> None:
        pass  # No per-session GPU state to release
```

### 2.2 NemotronEngine (new)

Uses NeMo toolkit for cache-aware streaming inference.

```python
# server/src/transcription/engines/nemotron.py

import nemo.collections.asr as nemo_asr
from transcription.base import AudioMode, EngineSession, TranscriptionEngine
from transcription.types import TranscribeResult

class NemotronEngine:
    """Adapter for NVIDIA Nemotron Speech Streaming."""

    audio_mode = AudioMode.INCREMENTAL

    def __init__(self, model_name: str, chunk_ms: int = 560) -> None:
        self._model = nemo_asr.models.ASRModel.from_pretrained(model_name)
        self._model.eval()
        self._chunk_ms = chunk_ms
        # Configure streaming decoding parameters
        self._model.change_decoding_strategy(None)

    def create_session(self) -> "NemotronSession":
        cache = self._model.encoder.get_initial_cache()
        return NemotronSession(self._model, cache)

    def shutdown(self) -> None:
        del self._model


class NemotronSession:
    """Per-session streaming state for Nemotron RNNT."""

    def __init__(self, model, cache) -> None:
        self._model = model
        self._cache = cache
        self._accumulated_text = ""
        self._last_speech_end: float | None = None

    def transcribe(
        self,
        audio: NDArray[np.float32],
        *,
        hotwords: str | None = None,  # Nemotron doesn't support hotwords yet
    ) -> TranscribeResult:
        # Process chunk through encoder with cache
        logits, self._cache = self._model.encoder(audio, cache=self._cache)
        tokens = self._model.decoding.decode(logits)
        new_text = self._model.tokenizer.ids_to_text(tokens)

        if new_text.strip():
            self._accumulated_text += new_text
            # Approximate speech end from chunk position (NeMo may provide better signal)
            self._last_speech_end = ...  # Track from audio duration

        return TranscribeResult(
            text=self._accumulated_text.strip(),
            confidence=0.9,  # RNNT doesn't produce per-segment log probs like Whisper
            last_speech_end=self._last_speech_end,
        )

    def finalize(self) -> TranscribeResult:
        # Flush any remaining tokens from the RNNT cache
        # (send a small silence buffer to push out buffered predictions)
        flush_audio = np.zeros(int(0.5 * 16000), dtype=np.float32)
        return self.transcribe(flush_audio)

    def close(self) -> None:
        # Release GPU cache tensors
        del self._cache
        self._cache = None
```

> **Note:** The NemotronEngine code above is illustrative pseudocode. The actual NeMo streaming API will need to be validated against the specific model's inference interface once the dependency is installed. The key design points (cache lifecycle, incremental audio, accumulated text) are accurate.

---

## 3. Engine Factory

A single factory function replaces the current `get_engine()` singleton.

```python
# server/src/transcription/factory.py

import logging
import threading

from config import Settings, get_settings
from transcription.base import TranscriptionEngine

logger = logging.getLogger(__name__)

_engine: TranscriptionEngine | None = None
_engine_lock = threading.Lock()


def get_engine() -> TranscriptionEngine:
    """Get the global TranscriptionEngine, creating it on first call."""
    global _engine

    if _engine is not None:
        return _engine

    with _engine_lock:
        if _engine is not None:
            return _engine

        settings = get_settings()
        _engine = _create_engine(settings)
        return _engine


def _create_engine(settings: Settings) -> TranscriptionEngine:
    """Instantiate the configured engine."""
    match settings.engine:
        case "whisper":
            from transcription.engines.whisper import WhisperEngine

            logger.info(
                "Loading Whisper engine: %s (device=%s, compute=%s)",
                settings.whisper_model,
                settings.whisper_device,
                settings.whisper_compute_type,
            )
            return WhisperEngine(
                model=settings.whisper_model,
                device=settings.whisper_device,
                compute_type=settings.whisper_compute_type,
            )

        case "nemotron":
            from transcription.engines.nemotron import NemotronEngine

            logger.info(
                "Loading Nemotron engine: %s (chunk=%dms)",
                settings.nemotron_model,
                settings.nemotron_chunk_ms,
            )
            return NemotronEngine(
                model_name=settings.nemotron_model,
                chunk_ms=settings.nemotron_chunk_ms,
            )

        case _:
            raise ValueError(f"Unknown engine: {settings.engine!r}")


def shutdown_engine() -> None:
    """Shutdown the global engine."""
    global _engine
    with _engine_lock:
        if _engine is not None:
            logger.info("Shutting down transcription engine")
            _engine.shutdown()
            _engine = None
```

**Lazy imports** are critical here — `from transcription.engines.nemotron import NemotronEngine` is inside the `"nemotron"` case so that NeMo is never imported when using Whisper. This avoids the heavy NeMo import penalty for Whisper-only users.

---

## 4. Configuration Changes

```python
# server/src/config.py — additions

class Settings(BaseSettings):
    # --- Engine selection ---
    engine: Literal["whisper", "nemotron"] = "whisper"

    # --- Whisper settings (existing, unchanged) ---
    whisper_model: str = "large-v3-turbo"
    whisper_device: Literal["auto", "cpu", "cuda"] = "auto"
    whisper_compute_type: Literal[
        "auto", "int8", "int8_float16", "int16", "float16", "float32"
    ] = "auto"

    # --- Nemotron settings (new) ---
    nemotron_model: str = "nvidia/nemotron-speech-streaming-en-0.6b"
    nemotron_chunk_ms: Literal[80, 160, 560, 1120] = 560
    nemotron_device: str = "cuda"

    # --- Transcription settings (existing, unchanged) ---
    partial_emission_interval: float = 0.25
    min_audio_for_transcription: float = 0.5
```

All settings are controlled via environment variables with `MURMUR_` prefix (e.g., `MURMUR_ENGINE=nemotron`, `MURMUR_NEMOTRON_CHUNK_MS=160`).

---

## 5. TranscriptionProcessor Changes

The processor is the main component that needs modification. It must handle both audio modes.

### 5.1 AudioBuffer Enhancement

Add a cursor for incremental consumption:

```python
# server/src/audio/buffer.py — additions

class AudioBuffer:
    # ... existing fields ...
    _cursor: int = 0  # Sample offset for incremental reads

    def get_new_audio_float32(self) -> NDArray[np.float32]:
        """Get audio added since the last call to this method.

        Returns float32 normalized to [-1.0, 1.0]. Advances the cursor.
        Used by incremental engines (Nemotron).
        """
        all_audio = self.get_audio()
        if self._cursor >= len(all_audio):
            return np.array([], dtype=np.float32)

        new_samples = all_audio[self._cursor:]
        self._cursor = len(all_audio)
        return new_samples.astype(np.float32) / 32768.0

    def get_audio_float32(self) -> NDArray[np.float32]:
        """Get ALL audio as float32. Existing method, unchanged.

        Used by full-buffer engines (Whisper).
        """
        # ... existing implementation ...
```

### 5.2 Processor Refactoring

```python
# server/src/transcription/processor.py — key changes

from transcription.base import AudioMode, EngineSession
from transcription.factory import get_engine

class TranscriptionProcessor:
    def __init__(self, context: "SessionContext") -> None:
        self._context = context
        self._settings = get_settings()

        # Create per-session engine state
        engine = get_engine()
        self._session: EngineSession = engine.create_session()
        self._audio_mode = engine.audio_mode

    async def transcribe_partial(self) -> TranscriptionResult | None:
        # ... minimum duration check (only for FULL_BUFFER mode) ...
        if self._audio_mode == AudioMode.FULL_BUFFER:
            if self._context.audio_buffer.duration_seconds < self._settings.min_audio_for_transcription:
                return None
            audio = self._context.audio_buffer.get_audio_float32()
        else:
            audio = self._context.audio_buffer.get_new_audio_float32()

        if len(audio) == 0:
            return None

        start_time = time.perf_counter()
        audio_duration = self._context.audio_buffer.duration_seconds

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            get_executor(),
            lambda: self._session.transcribe(audio, hotwords=self._context.hotwords),
        )

        transcription_time = time.perf_counter() - start_time

        if result.text == self._context.last_partial_text:
            return None

        self._context.last_partial_text = result.text

        return TranscriptionResult(
            text=result.text,
            confidence=result.confidence,
            is_empty=len(result.text.strip()) == 0,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
            last_speech_end=result.last_speech_end,
        )

    async def transcribe_final(self) -> TranscriptionResult:
        start_time = time.perf_counter()
        audio_duration = self._context.audio_buffer.duration_seconds

        if self._audio_mode == AudioMode.FULL_BUFFER:
            audio = self._context.audio_buffer.get_audio_float32()
            if len(audio) == 0:
                return TranscriptionResult(text="", confidence=0.0, is_empty=True,
                                           transcription_time=0.0, audio_duration=0.0,
                                           last_speech_end=None)
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                get_executor(),
                lambda: self._session.transcribe(audio, hotwords=self._context.hotwords),
            )
        else:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                get_executor(),
                self._session.finalize,
            )

        transcription_time = time.perf_counter() - start_time

        return TranscriptionResult(
            text=result.text,
            confidence=result.confidence,
            is_empty=len(result.text.strip()) == 0,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
            last_speech_end=result.last_speech_end,
        )

    def close(self) -> None:
        """Release per-session engine resources."""
        self._session.close()
```

### 5.3 Handler Update

In `websocket/handler.py`, add cleanup for the processor's engine session:

```python
# In websocket_handler, in the finally block:
processor.close()  # Release per-session GPU state
```

---

## 6. Dependency Management

### 6.1 pyproject.toml Structure

Use optional dependency groups to keep the base install light:

```toml
[project]
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "pydantic>=2.10.0",
    "pydantic-settings>=2.6.0",
    "numpy>=1.26.0",
    # Note: no engine dependency in base — at least one optional group required
]

[project.optional-dependencies]
whisper = [
    "faster-whisper>=1.1.0",
]
nemotron = [
    "nemo_toolkit[asr]>=2.2.0",
]

# Combined convenience groups
all-engines = [
    "murmur[whisper,nemotron]",
]
```

**Install commands:**
```bash
uv sync --extra whisper          # Whisper only (current behavior)
uv sync --extra nemotron         # Nemotron only
uv sync --extra all-engines      # Both engines
```

### 6.2 Runtime Dependency Checks

The factory should validate that the selected engine's dependencies are actually installed:

```python
def _create_engine(settings: Settings) -> TranscriptionEngine:
    match settings.engine:
        case "whisper":
            try:
                from transcription.engines.whisper import WhisperEngine
            except ImportError:
                raise RuntimeError(
                    "Whisper engine requires faster-whisper. "
                    "Install with: uv sync --extra whisper"
                )
            # ...

        case "nemotron":
            try:
                from transcription.engines.nemotron import NemotronEngine
            except ImportError:
                raise RuntimeError(
                    "Nemotron engine requires nemo_toolkit. "
                    "Install with: uv sync --extra nemotron"
                )
            # ...
```

---

## 7. File Layout

### 7.1 New File Structure

```
server/src/transcription/
├── __init__.py
├── base.py              # Protocols: TranscriptionEngine, EngineSession, AudioMode
├── types.py             # TranscribeResult dataclass
├── factory.py           # get_engine(), _create_engine(), shutdown_engine()
├── processor.py         # TranscriptionProcessor (updated)
├── engines/
│   ├── __init__.py
│   ├── whisper.py       # WhisperEngine + WhisperSession
│   └── nemotron.py      # NemotronEngine + NemotronSession
```

### 7.2 Files Modified

| File | Change |
|------|--------|
| `transcription/engine.py` | **Deleted** — replaced by `factory.py` + `engines/whisper.py` |
| `transcription/processor.py` | Updated to use `EngineSession` + `AudioMode` |
| `audio/buffer.py` | Add `get_new_audio_float32()` with cursor |
| `config.py` | Add `engine`, `nemotron_*` settings |
| `app.py` | Import from `transcription.factory` instead of `transcription.engine` |
| `websocket/handler.py` | Call `processor.close()` in finally block |
| `pyproject.toml` | Split engine deps into optional groups |

### 7.3 Files Unchanged

| File | Why |
|------|-----|
| `protocol/*` | Protocol is engine-agnostic |
| `audio/parser.py` | Audio frame parsing is engine-agnostic |
| `session/context.py` | Session state doesn't reference engine directly |
| `session/state.py` | State machine is engine-agnostic |
| `session/manager.py` | Session lifecycle is engine-agnostic |
| `websocket/sender.py` | Frame sending is engine-agnostic |

---

## 8. Partial Emission Behavior

### 8.1 Whisper (FULL_BUFFER)

Behavior is identical to today:
- Timer fires every `partial_emission_interval` (default 250ms)
- Full buffer is re-transcribed
- Text diff check against `last_partial_text`
- Growing inference time as audio accumulates

### 8.2 Nemotron (INCREMENTAL)

The timer loop still works but now feeds only new chunks:
- Timer fires every `partial_emission_interval`
- Only new audio since last call is processed
- Constant inference time (~43ms) regardless of total duration
- Text is accumulated inside `NemotronSession`
- The diff check still applies (avoids sending duplicate partials)

The timer-based approach works for both modes. An event-driven approach (emit immediately when RNNT produces tokens) is a future optimization but not required for the initial integration. The timer already fires frequently enough (250ms) that the additional latency is negligible compared to the baseline improvement.

---

## 9. Session Lifecycle with Engine Sessions

```
WebSocket connect
    │
    ├─ SessionManager.create_session() → SessionContext
    │
    ├─ Wait for start frame
    │
    ├─ TranscriptionProcessor(context)
    │       └─ engine.create_session() → EngineSession
    │           (Whisper: no-op; Nemotron: allocate GPU cache)
    │
    ├─ Start partial_emission_loop + silence_monitor_loop
    │
    ├─ Audio loop:
    │     audio → buffer.append()
    │     timer → processor.transcribe_partial()
    │               ├─ FULL_BUFFER: buffer.get_audio_float32() → session.transcribe(all)
    │               └─ INCREMENTAL: buffer.get_new_audio_float32() → session.transcribe(new)
    │
    ├─ Stop/timeout:
    │     processor.transcribe_final()
    │       ├─ FULL_BUFFER: session.transcribe(all)
    │       └─ INCREMENTAL: session.finalize() [flush cache]
    │
    ├─ Send final + closing frames
    │
    └─ Cleanup:
          processor.close()
              └─ session.close() [release GPU cache]
          manager.remove_session()
          websocket.close()
```

---

## 10. Testing Strategy

### 10.1 Unit Tests

- **Mock engines**: Create `FakeEngine` / `FakeSession` implementing the protocols for testing processor logic without real models
- **AudioBuffer cursor**: Test `get_new_audio_float32()` returns only new data and advances correctly
- **Factory**: Test engine selection with mocked imports
- **Config validation**: Test that invalid engine names, chunk sizes, etc. are rejected

### 10.2 Integration Tests

- **Whisper round-trip**: Existing test suite should pass unchanged (verifies adapter correctness)
- **Engine switching**: Test that `MURMUR_ENGINE=whisper` and `MURMUR_ENGINE=nemotron` each start correctly
- **Session lifecycle**: Test that `EngineSession.close()` is always called, even on errors

### 10.3 Backward Compatibility

The default configuration (`engine = "whisper"`) produces **identical behavior** to the current codebase. The only visible change is the import path (`transcription.factory.get_engine` vs `transcription.engine.get_engine`), which is an internal detail.

---

## 11. Migration Checklist

### Phase 1: Abstraction (no new deps, no behavior change)

- [ ] Create `transcription/types.py` with `TranscribeResult`
- [ ] Create `transcription/base.py` with `TranscriptionEngine`, `EngineSession`, `AudioMode` protocols
- [ ] Create `transcription/engines/whisper.py` — move existing `WhisperEngine` logic here
- [ ] Create `transcription/factory.py` — replace `transcription/engine.py`
- [ ] Delete `transcription/engine.py`
- [ ] Add `get_new_audio_float32()` + cursor to `AudioBuffer`
- [ ] Update `TranscriptionProcessor` to use abstract interface
- [ ] Add `processor.close()` to handler cleanup
- [ ] Add `engine` setting to `Settings` (default `"whisper"`)
- [ ] Update `app.py` imports
- [ ] Update all tests
- [ ] Verify `just test` passes with zero behavior change

### Phase 2: Nemotron integration

- [ ] Add `nemotron` optional dependency group to `pyproject.toml`
- [ ] Create `transcription/engines/nemotron.py`
- [ ] Add `nemotron_*` settings to `Settings`
- [ ] Add dependency check error messages to factory
- [ ] Write integration tests for Nemotron engine
- [ ] Test with real audio on GPU
- [ ] Benchmark chunk sizes (80ms, 160ms, 560ms, 1120ms)
- [ ] Document setup in README

### Phase 3: Optimization (future)

- [ ] ONNX Runtime export for lighter Nemotron deployment
- [ ] Event-driven partial emission for INCREMENTAL mode
- [ ] Hybrid mode: Nemotron partials + Parakeet-TDT finals
- [ ] Confidence calibration for RNNT output
