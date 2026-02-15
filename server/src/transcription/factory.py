"""Engine creation, discovery, and hot-swap management."""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING

from transcription.base import AudioMode, EngineInfo, EngineSession, TranscriptionEngine

if TYPE_CHECKING:
    from config import Settings

logger = logging.getLogger(__name__)


def discover_engines() -> list[dict]:
    available = []

    try:
        import nemo.collections.asr  # noqa: F401
        available.append({
            "id": "nemotron",
            "name": "Nemotron Speech",
            "available": True,
            "description": "True streaming with constant ~44ms latency. English only.",
            "model_size_gb": 2.3,
            "languages": ["en"],
            "features": ["true_streaming", "constant_latency"],
        })
    except ImportError:
        available.append({
            "id": "nemotron",
            "name": "Nemotron Speech",
            "available": False,
            "description": "True streaming with constant ~44ms latency. English only.",
            "install_hint": "uv sync --extra nemotron",
        })

    try:
        import faster_whisper  # noqa: F401
        available.append({
            "id": "whisper",
            "name": "Faster-Whisper",
            "available": True,
            "description": "Legacy re-transcribe mode. 25+ languages.",
            "model_size_gb": 1.5,
            "languages": ["en", "de", "fr", "es", "it", "ja", "zh", "nl", "ko", "pt"],
            "features": ["multilingual", "hotwords"],
        })
    except ImportError:
        available.append({
            "id": "whisper",
            "name": "Faster-Whisper",
            "available": False,
            "description": "Legacy re-transcribe mode. 25+ languages.",
            "install_hint": "uv sync --extra whisper",
        })

    return available


def _get_available_engine_ids() -> list[str]:
    return [e["id"] for e in discover_engines() if e["available"]]


def _create_engine(settings: Settings) -> TranscriptionEngine:
    engine_id = settings.engine

    if engine_id == "nemotron":
        try:
            from transcription.engines.nemotron import NemotronEngine
        except ImportError:
            raise RuntimeError(
                "Nemotron engine requires nemo_toolkit. Install with: uv sync --extra nemotron"
            )
        return NemotronEngine(
            model_name=settings.nemotron_model,
            chunk_ms=settings.nemotron_chunk_ms,
            device=settings.nemotron_device,
        )

    if engine_id == "whisper":
        try:
            from transcription.engines.whisper import WhisperEngine
        except ImportError:
            raise RuntimeError(
                "Whisper engine requires faster-whisper. Install with: uv sync --extra whisper"
            )
        return WhisperEngine(
            model=settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
        )

    raise ValueError(f"Unknown engine: {engine_id!r}")


@dataclass
class EngineStatus:
    current: str
    status: str  # "ready", "loading", "error"
    info: EngineInfo | None = None
    pending: dict | None = None
    error_message: str | None = None


class EngineManager:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._engine: TranscriptionEngine | None = None
        self._lock = threading.Lock()
        self._active_sessions: dict[str, TranscriptionEngine] = {}
        self._pending_status: str | None = None
        self._pending_engine_id: str | None = None
        self._pending_message: str | None = None
        self._swap_error: str | None = None

    def load_initial_engine(self) -> None:
        engine_id = self._settings.engine
        available = _get_available_engine_ids()

        if engine_id not in available:
            # Fallback logic: nemotron → whisper
            fallback = "whisper" if engine_id == "nemotron" else "nemotron"
            if fallback in available:
                logger.warning(
                    "%s not available, falling back to %s", engine_id, fallback
                )
                engine_id = fallback
                self._settings.engine = fallback  # type: ignore[assignment]
            else:
                raise RuntimeError(
                    f"No transcription engines available. "
                    f"Install at least one: uv sync --extra nemotron  or  uv sync --extra whisper"
                )

        self._engine = _create_engine(self._settings)

    @property
    def engine(self) -> TranscriptionEngine:
        if self._engine is None:
            raise RuntimeError("Engine not loaded. Call load_initial_engine() first.")
        return self._engine

    @property
    def engine_info(self) -> EngineInfo:
        return self.engine.engine_info

    @property
    def audio_mode(self) -> AudioMode:
        return self.engine.audio_mode

    def get_status(self) -> EngineStatus:
        info = self._engine.engine_info if self._engine else None
        status = EngineStatus(
            current=self._settings.engine,
            status="ready" if self._engine and not self._pending_status else "loading",
            info=info,
        )
        if self._pending_status:
            status.pending = {
                "engine": self._pending_engine_id,
                "status": self._pending_status,
                "message": self._pending_message,
            }
        if self._swap_error:
            status.error_message = self._swap_error
            self._swap_error = None
        return status

    def create_session(self, session_id: str) -> EngineSession:
        with self._lock:
            engine = self.engine
            session = engine.create_session()
            self._active_sessions[session_id] = engine
            return session

    def release_session(self, session_id: str) -> None:
        with self._lock:
            engine = self._active_sessions.pop(session_id, None)
            if engine is not None and engine is not self._engine:
                # Last session on a retired engine — shut it down
                if engine not in self._active_sessions.values():
                    logger.info("Shutting down retired engine")
                    try:
                        engine.shutdown()
                    except Exception as e:
                        logger.error("Error shutting down retired engine: %s", e)

    @property
    def active_session_count(self) -> int:
        with self._lock:
            return len(self._active_sessions)

    async def swap_engine(self, new_settings: Settings) -> None:
        self._pending_engine_id = new_settings.engine
        self._pending_status = "loading"
        self._pending_message = f"Loading {new_settings.engine} engine..."

        unload_first = getattr(new_settings, "unload_before_swap", False)

        try:
            loop = asyncio.get_running_loop()

            if unload_first and self._engine is not None:
                old_engine = self._engine
                with self._lock:
                    # Only unload if no active sessions
                    if not self._active_sessions:
                        self._engine = None
                        await loop.run_in_executor(None, old_engine.shutdown)
                    else:
                        logger.warning("Cannot unload engine while sessions are active, loading new engine alongside")

            new_engine = await loop.run_in_executor(None, lambda: _create_engine(new_settings))

            with self._lock:
                old_engine = self._engine
                self._engine = new_engine
                self._settings = new_settings

                # Check if old engine has active sessions
                has_active = old_engine is not None and old_engine in self._active_sessions.values()

            if old_engine is not None and not has_active:
                await loop.run_in_executor(None, old_engine.shutdown)

            self._pending_status = None
            self._pending_engine_id = None
            self._pending_message = None
            logger.info("Engine swap complete: now using %s", new_settings.engine)

        except Exception as e:
            logger.error("Engine swap failed: %s", e)
            self._swap_error = str(e)
            self._pending_status = None
            self._pending_engine_id = None
            self._pending_message = None
            raise

    def shutdown(self) -> None:
        with self._lock:
            if self._engine is not None:
                logger.info("Shutting down engine manager")
                self._engine.shutdown()
                self._engine = None


# Global engine manager
_manager: EngineManager | None = None
_manager_lock = threading.Lock()


def get_engine_manager() -> EngineManager:
    if _manager is None:
        raise RuntimeError("EngineManager not initialized. Call init_engine_manager() first.")
    return _manager


def init_engine_manager(settings: Settings) -> EngineManager:
    global _manager
    with _manager_lock:
        if _manager is not None:
            return _manager
        _manager = EngineManager(settings)
        _manager.load_initial_engine()
        return _manager


def shutdown_engine_manager() -> None:
    global _manager
    with _manager_lock:
        if _manager is not None:
            _manager.shutdown()
            _manager = None
