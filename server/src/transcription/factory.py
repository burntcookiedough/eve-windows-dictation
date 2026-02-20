"""Engine creation, discovery, and hot-swap management."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from transcription.base import EngineInfo, EngineSession, TranscriptionEngine
from transcription.vram import (
    detect_gpu_capabilities,
    estimate_max_duration_s,
    get_vram_profile,
)

if TYPE_CHECKING:
    from config import Settings

logger = logging.getLogger(__name__)

# region agent log
_DEBUG_LOG_PATH_RAW = "/home/dikka/raikr/Documents/projs/murmur/nemotron/.cursor/debug-46f840.log"
_DEBUG_SESSION_ID = "46f840"
_DEBUG_RUN_ID = "startup-nemotron-availability"
_DEBUG_SERVER_ENDPOINT = "http://127.0.0.1:7298/ingest/10253f83-4bde-4571-ac40-abb1de60ac60"


def _resolve_debug_log_path() -> str:
    # In Windows runtime, map to the repo-local .cursor log path.
    if os.name == "nt":
        return str(Path(__file__).resolve().parents[3] / ".cursor" / "debug-46f840.log")
    return _DEBUG_LOG_PATH_RAW


_DEBUG_LOG_PATH = _resolve_debug_log_path()


def _debug_log(
    hypothesis_id: str,
    location: str,
    message: str,
    data: dict,
) -> None:
    payload = {
        "sessionId": _DEBUG_SESSION_ID,
        "runId": _DEBUG_RUN_ID,
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": int(time.time() * 1000),
    }
    try:
        os.makedirs(os.path.dirname(_DEBUG_LOG_PATH), exist_ok=True)
        with open(_DEBUG_LOG_PATH, "a", encoding="utf-8") as debug_file:
            debug_file.write(json.dumps(payload, ensure_ascii=True) + "\n")
        return
    except Exception:
        pass
    try:
        request = urllib.request.Request(
            _DEBUG_SERVER_ENDPOINT,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Debug-Session-Id": _DEBUG_SESSION_ID,
            },
            data=json.dumps(payload, ensure_ascii=True).encode("utf-8"),
        )
        with urllib.request.urlopen(request, timeout=1):
            return
    except Exception:
        # Never break engine startup because of debug logging.
        return

# endregion


def discover_engines() -> list[dict]:
    available = []
    # region agent log
    _debug_log(
        "H3-environment-mismatch",
        "transcription/factory.py:discover_engines:entry",
        "Engine discovery started",
        {
            "python_executable": sys.executable,
            "python_version": sys.version.split()[0],
            "cwd": os.getcwd(),
            "os_name": os.name,
            "debug_log_path": _DEBUG_LOG_PATH,
            "path_head": sys.path[:5],
        },
    )
    # endregion

    try:
        import nemo.collections.asr as nemo_asr  # noqa: F401
        # region agent log
        _debug_log(
            "H1-nemo-package-missing",
            "transcription/factory.py:discover_engines:nemo:success",
            "Nemotron dependency import succeeded",
            {
                "module_file": getattr(nemo_asr, "__file__", None),
            },
        )
        # endregion
        available.append({
            "id": "nemotron",
            "name": "Nemotron Speech",
            "available": True,
            "description": "Fast batch retranscribe, ~93x real-time. English only.",
            "model_size_gb": 2.3,
            "languages": ["en"],
            "features": ["fast_batch", "constant_latency"],
        })
    except ImportError as error:
        # region agent log
        _debug_log(
            "H2-nemo-transitive-importerror",
            "transcription/factory.py:discover_engines:nemo:importerror",
            "Nemotron dependency import failed",
            {
                "error_type": type(error).__name__,
                "error": str(error),
                "missing_name": getattr(error, "name", None),
                "missing_path": getattr(error, "path", None),
            },
        )
        # endregion
        available.append({
            "id": "nemotron",
            "name": "Nemotron Speech",
            "available": False,
            "description": "Fast batch retranscribe, ~93x real-time. English only.",
            "install_hint": "uv sync --extra nemotron",
        })

    try:
        import faster_whisper as faster_whisper_module  # noqa: F401
        # region agent log
        _debug_log(
            "H3-environment-mismatch",
            "transcription/factory.py:discover_engines:whisper:success",
            "Whisper dependency import succeeded",
            {
                "module_file": getattr(faster_whisper_module, "__file__", None),
            },
        )
        # endregion
        available.append({
            "id": "whisper",
            "name": "Faster-Whisper",
            "available": True,
            "description": "Batch retranscribe mode. 25+ languages.",
            "model_size_gb": 1.5,
            "languages": ["en", "de", "fr", "es", "it", "ja", "zh", "nl", "ko", "pt"],
            "features": ["multilingual", "hotwords"],
        })
    except ImportError as error:
        # region agent log
        _debug_log(
            "H3-environment-mismatch",
            "transcription/factory.py:discover_engines:whisper:importerror",
            "Whisper dependency import failed",
            {
                "error_type": type(error).__name__,
                "error": str(error),
                "missing_name": getattr(error, "name", None),
                "missing_path": getattr(error, "path", None),
            },
        )
        # endregion
        available.append({
            "id": "whisper",
            "name": "Faster-Whisper",
            "available": False,
            "description": "Batch retranscribe mode. 25+ languages.",
            "install_hint": "uv sync --extra whisper",
        })

    # region agent log
    _debug_log(
        "H4-discovery-selection-mismatch",
        "transcription/factory.py:discover_engines:result",
        "Engine discovery completed",
        {
            "available_ids": [engine["id"] for engine in available if engine["available"]],
            "all_engines": available,
        },
    )
    # endregion
    return available


def _get_available_engine_ids() -> list[str]:
    return [e["id"] for e in discover_engines() if e["available"]]


def _get_engine_device(settings: Settings, engine_id: str) -> str:
    if engine_id == "nemotron":
        return settings.nemotron_device
    if engine_id == "whisper":
        return settings.whisper_device
    return "auto"


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
    message: str | None = None


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
        self._gpu_name: str | None = None
        self._gpu_vram_gb: float | None = None
        self._estimated_max_duration_s: int | None = None

    def _resolve_engine_availability(
        self,
        settings: Settings,
        available: list[str],
    ) -> None:
        engine_id = settings.engine
        # region agent log
        _debug_log(
            "H4-discovery-selection-mismatch",
            "transcription/factory.py:_resolve_engine_availability:entry",
            "Resolving selected engine availability",
            {
                "requested_engine": engine_id,
                "available_ids": available,
                "engine_preference_mode": getattr(settings, "engine_preference_mode", None),
            },
        )
        # endregion
        if engine_id in available:
            return

        fallback = "whisper" if engine_id == "nemotron" else "nemotron"
        if fallback in available:
            # region agent log
            _debug_log(
                "H4-discovery-selection-mismatch",
                "transcription/factory.py:_resolve_engine_availability:fallback",
                "Requested engine unavailable, applying fallback",
                {
                    "requested_engine": engine_id,
                    "fallback_engine": fallback,
                    "available_ids": available,
                },
            )
            # endregion
            logger.warning("%s not available, falling back to %s", engine_id, fallback)
            settings.engine = fallback  # type: ignore[assignment]
            return

        # region agent log
        _debug_log(
            "H4-discovery-selection-mismatch",
            "transcription/factory.py:_resolve_engine_availability:none-available",
            "No engines available after discovery",
            {
                "requested_engine": engine_id,
                "available_ids": available,
            },
        )
        # endregion
        raise RuntimeError(
            "No transcription engines available. "
            "Install at least one: uv sync --extra nemotron  or  uv sync --extra whisper"
        )

    def _apply_vram_policy(self, settings: Settings, available: list[str]) -> None:
        if settings.engine != "nemotron":
            return

        profile = get_vram_profile("nemotron")
        if profile is None:
            return

        capabilities = detect_gpu_capabilities(settings.nemotron_device)
        total_vram_gb = capabilities.total_vram_gb
        estimated_s = estimate_max_duration_s("nemotron", total_vram_gb)

        if (
            profile.min_recommended_vram_gb is not None
            and total_vram_gb is not None
            and total_vram_gb < profile.min_recommended_vram_gb
        ):
            if settings.engine_preference_mode == "manual":
                logger.warning(
                    "Nemotron explicitly selected on low-VRAM GPU "
                    "(gpu=%s, vram=%.1f GB, estimated_max=~%ss).",
                    capabilities.name or "unknown",
                    total_vram_gb,
                    estimated_s if estimated_s is not None else "unknown",
                )
                return

            if "whisper" in available:
                logger.warning(
                    "Detected %.1f GB VRAM for Nemotron (recommended >= %.1f GB); "
                    "auto-falling back to whisper.",
                    total_vram_gb,
                    profile.min_recommended_vram_gb,
                )
                settings.engine = "whisper"
                return

            raise RuntimeError(
                "Nemotron selected but detected VRAM is below recommended minimum "
                f"({total_vram_gb:.1f} GB < {profile.min_recommended_vram_gb:.1f} GB), "
                "and whisper fallback is unavailable."
            )

        if total_vram_gb is not None and estimated_s is not None:
            logger.info(
                "Nemotron VRAM estimate: gpu=%s vram=%.1f GB estimated_max=~%ss",
                capabilities.name or "unknown",
                total_vram_gb,
                estimated_s,
            )
        elif capabilities.reason:
            logger.info("Nemotron VRAM estimate unavailable: %s", capabilities.reason)

    def _prepare_engine_selection(
        self,
        settings: Settings,
        available: list[str],
    ) -> None:
        self._resolve_engine_availability(settings, available)
        self._apply_vram_policy(settings, available)

    def _update_runtime_metadata(self, settings: Settings) -> None:
        device = _get_engine_device(settings, settings.engine)
        capabilities = detect_gpu_capabilities(device)
        estimated_max_duration_s = estimate_max_duration_s(
            settings.engine,
            capabilities.total_vram_gb,
        )

        self._gpu_name = capabilities.name
        self._gpu_vram_gb = capabilities.total_vram_gb
        self._estimated_max_duration_s = estimated_max_duration_s

        if capabilities.total_vram_gb is not None:
            logger.info(
                "Engine ready: %s (gpu=%s, vram=%.1f GB, estimated_max=~%ss)",
                settings.engine,
                capabilities.name or "unknown",
                capabilities.total_vram_gb,
                estimated_max_duration_s if estimated_max_duration_s is not None else "unknown",
            )
        elif capabilities.reason:
            logger.info(
                "Engine ready: %s (gpu info unavailable: %s)",
                settings.engine,
                capabilities.reason,
            )

    def load_initial_engine(self) -> None:
        available = _get_available_engine_ids()
        self._prepare_engine_selection(self._settings, available)
        self._engine = _create_engine(self._settings)
        self._update_runtime_metadata(self._settings)

    @property
    def engine(self) -> TranscriptionEngine:
        if self._engine is None:
            raise RuntimeError("Engine not loaded. Call load_initial_engine() first.")
        return self._engine

    @property
    def engine_info(self) -> EngineInfo:
        return replace(
            self.engine.engine_info,
            gpu_name=self._gpu_name,
            gpu_vram_gb=self._gpu_vram_gb,
            estimated_max_duration_s=self._estimated_max_duration_s,
        )

    def get_status(self) -> EngineStatus:
        info = self.engine_info if self._engine else None
        if self._pending_status:
            status_value = "loading"
        elif self._swap_error:
            status_value = "error"
        elif self._engine:
            status_value = "ready"
        else:
            status_value = "loading"

        status = EngineStatus(
            current=self._settings.engine,
            status=status_value,
            info=info,
        )
        if self._pending_status:
            status.pending = {
                "engine": self._pending_engine_id,
                "status": self._pending_status,
                "message": self._pending_message,
            }
        if self._swap_error:
            status.message = self._swap_error
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
        try:
            self._swap_error = None
            available = _get_available_engine_ids()
            self._prepare_engine_selection(new_settings, available)

            self._pending_engine_id = new_settings.engine
            self._pending_status = "loading"
            self._pending_message = f"Loading {new_settings.engine} engine..."

            unload_first = getattr(new_settings, "unload_before_swap", False)
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

            self._update_runtime_metadata(new_settings)

            if old_engine is not None and not has_active:
                await loop.run_in_executor(None, old_engine.shutdown)

            self._pending_status = None
            self._pending_engine_id = None
            self._pending_message = None
            self._swap_error = None
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
