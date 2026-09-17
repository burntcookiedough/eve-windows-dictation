"""Composition root for the single Faster-Whisper model runtime.

The runtime owns preparation, activation, session leases, and shutdown.  This
module only wires the concrete adapter and translates the typed model seam to
the legacy transport spelling that the Electron client still consumes during
the migration release.  It deliberately contains no second manager or model
selection policy.
"""

from __future__ import annotations

import importlib.util
import threading
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

from transcription.catalog import FASTER_WHISPER_CATALOG
from transcription.contracts import (
    Failed,
    ModelAdapter,
    ModelId,
    ModelInfo,
    Preparing,
    Ready,
    RuntimeStatus,
    Starting,
    Stopping,
    WhisperConfig,
)
from transcription.faster_whisper_adapter import FasterWhisperAdapter
from transcription.model_runtime import ModelRuntime

if TYPE_CHECKING:
    from config import Settings


SUPPORTED_ENGINE_ID = "whisper"
SUPPORTED_ENGINE_NAME = "Faster-Whisper"

_runtime: ModelRuntime | None = None
_runtime_lock = threading.Lock()


def whisper_config_from_settings(settings: Settings) -> WhisperConfig:
    """Translate the complete validated settings object at one seam.

    ``engine`` remains a frozen transport/settings key, while retired family
    fields are removed by ``legacy_settings`` before this seam.  The runtime
    always prepares the supported Faster-Whisper family.
    """

    return WhisperConfig(
        model=ModelId(str(settings.whisper_model)),
        device=settings.whisper_device,
        compute_type=settings.whisper_compute_type,
        language=settings.whisper_language,
        beam_size=settings.whisper_beam_size,
        temperature=settings.whisper_temperature,
        condition_on_previous_text=settings.whisper_condition_on_previous_text,
        without_timestamps=settings.whisper_without_timestamps,
        vad_filter=settings.whisper_vad_filter,
        vad_min_silence_duration_ms=settings.whisper_vad_min_silence_duration_ms,
        vad_speech_pad_ms=settings.whisper_vad_speech_pad_ms,
        vad_threshold=settings.whisper_vad_threshold,
    )


def create_model_runtime(
    settings: Settings,
    *,
    adapter: ModelAdapter | None = None,
) -> ModelRuntime:
    """Build one runtime instance for the process composition root."""

    return ModelRuntime(
        adapter=adapter or FasterWhisperAdapter(),
        initial=whisper_config_from_settings(settings),
    )


def init_model_runtime(
    settings: Settings,
    *,
    adapter: ModelAdapter | None = None,
) -> ModelRuntime:
    """Install and return the process runtime without starting native work.

    Startup preparation is asynchronous and is explicitly owned by the
    application lifespan.  Keeping construction separate makes the lifecycle
    deterministic in tests and prevents an import-time model load.
    """

    global _runtime
    with _runtime_lock:
        if _runtime is None:
            _runtime = create_model_runtime(settings, adapter=adapter)
        return _runtime


def get_model_runtime() -> ModelRuntime:
    """Return the initialized process runtime."""

    with _runtime_lock:
        runtime = _runtime
    if runtime is None:
        raise RuntimeError("ModelRuntime not initialized. Call init_model_runtime() first.")
    return runtime


async def shutdown_model_runtime() -> None:
    """Detach and await the process runtime's deterministic async shutdown."""

    global _runtime
    with _runtime_lock:
        runtime = _runtime
        _runtime = None
    if runtime is not None:
        await runtime.shutdown()


def model_info_to_engine_payload(info: ModelInfo) -> dict[str, Any]:
    """Serialize model facts using the existing Electron ``engine`` shape.

    The internal seam is model-oriented, while the compatibility payload keeps
    the stable ``id``, ``name``, and ``model_size_gb`` fields.  New callers can
    also consume ``size_gb``; all measured telemetry remains present.
    """

    return {
        "id": SUPPORTED_ENGINE_ID,
        "name": SUPPORTED_ENGINE_NAME,
        "model": str(info.model),
        "supports_hotwords": info.supports_hotwords,
        "languages": list(info.languages),
        "model_size_gb": info.size_gb,
        "size_gb": info.size_gb,
        "gpu_name": info.gpu_name,
        "gpu_vram_gb": info.gpu_vram_gb,
        "estimated_max_duration_s": info.estimated_max_duration_s,
        "repo_id": info.repo_id,
        "model_path": info.model_path,
        "device": info.device,
        "compute_type": info.compute_type,
        "cuda_active": info.cuda_active,
        "load_time_s": info.load_time_s,
        "last_transcription_latency_s": info.last_transcription_latency_s,
        "vram_used_gb": info.vram_used_gb,
    }


def _progress_payload(progress: Any) -> dict[str, Any] | None:
    if progress is None:
        return None
    try:
        return asdict(progress)
    except TypeError:
        return None


def runtime_status_to_engine_payload(status: RuntimeStatus) -> dict[str, Any]:
    """Serialize a runtime status without leaking native/provider exceptions."""

    info: ModelInfo | None = None
    legacy_status = "loading"
    message: str | None = None
    pending: dict[str, Any] | None = None
    active_sessions = 0
    draining_sessions = 0

    if isinstance(status, Ready):
        info = status.model
        legacy_status = "ready"
        active_sessions = status.active_sessions
        draining_sessions = status.draining_sessions
    elif isinstance(status, Preparing):
        info = status.current
        active_sessions = status.active_sessions
        pending = {
            "engine": SUPPORTED_ENGINE_ID,
            "model": str(status.candidate),
            "status": "loading",
            "message": "Loading Faster-Whisper model...",
        }
        progress = _progress_payload(status.progress)
        if progress is not None:
            pending["progress"] = progress
    elif isinstance(status, Failed):
        info = status.current
        legacy_status = "error"
        message = status.error.message
        pending = {
            "engine": SUPPORTED_ENGINE_ID,
            "model": str(status.candidate),
            "status": "error",
            "message": status.error.message,
        }
    elif isinstance(status, Starting):
        legacy_status = "loading"
    elif isinstance(status, Stopping):
        # The desktop parser only knows the historical loading/ready/error
        # values.  Keep a stopping runtime non-ready without breaking it.
        legacy_status = "loading"
        message = "Faster-Whisper runtime is stopping."

    payload: dict[str, Any] = {
        "current": SUPPORTED_ENGINE_ID,
        "status": legacy_status,
        "info": model_info_to_engine_payload(info) if info else None,
        "active_sessions": active_sessions,
        "draining_sessions": draining_sessions,
    }
    if pending is not None:
        payload["pending"] = pending
    if message is not None:
        payload["message"] = message
    return payload


def runtime_accepts_sessions(status: RuntimeStatus) -> bool:
    """Return whether a caller may admit a session on the current generation."""

    if isinstance(status, Ready):
        return True
    if isinstance(status, Preparing):
        return status.current is not None
    return isinstance(status, Failed) and status.current is not None


def discover_models() -> list[dict[str, Any]]:
    """Return presentation metadata for the supported model family."""

    available = _module_is_available("faster_whisper")
    first = FASTER_WHISPER_CATALOG[0]
    return [
        {
            "id": SUPPORTED_ENGINE_ID,
            "name": SUPPORTED_ENGINE_NAME,
            "available": available,
            "description": "Batch retranscribe mode. 25+ languages.",
            "model_size_gb": first.size_gb,
            "languages": list(first.languages),
            "features": ["multilingual", "hotwords"],
            **({} if available else {"install_hint": "uv sync --extra whisper"}),
            "models": [
                {
                    "id": str(item.model),
                    "label": item.label,
                    "repo_id": item.repo_id,
                    "model_size_gb": item.size_gb,
                    "languages": list(item.languages),
                    "supports_hotwords": item.supports_hotwords,
                }
                for item in FASTER_WHISPER_CATALOG
            ],
        }
    ]


def discover_engines() -> list[dict[str, Any]]:
    """Deprecated transport alias for ``discover_models``.

    It has no lifecycle or independent state.  Keep it until the Electron
    settings client finishes the model-catalog migration.
    """

    return discover_models()


def _module_is_available(module_name: str) -> bool:
    """Check an optional package without executing import-time model code."""

    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


__all__ = [
    "SUPPORTED_ENGINE_ID",
    "SUPPORTED_ENGINE_NAME",
    "create_model_runtime",
    "discover_engines",
    "discover_models",
    "get_model_runtime",
    "init_model_runtime",
    "model_info_to_engine_payload",
    "runtime_accepts_sessions",
    "runtime_status_to_engine_payload",
    "shutdown_model_runtime",
    "whisper_config_from_settings",
]
