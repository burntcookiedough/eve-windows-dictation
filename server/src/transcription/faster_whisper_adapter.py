"""Faster-Whisper implementation of the model adapter seam."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any

from transcription.catalog import FASTER_WHISPER_CATALOG, ModelCatalogItem
from transcription.contracts import (
    ModelAdapter,
    ModelId,
    ModelInfo,
    ModelSession,
    PreparedModel,
    PreparationProgress,
    ProgressSink,
    WhisperConfig,
)
from transcription.vram import detect_gpu_capabilities, estimate_max_duration_s

logger = logging.getLogger(__name__)

# Kept as a module symbol so tests can replace the native constructor without
# importing optional Faster-Whisper dependencies.  Production resolves it on
# first use, preserving a lightweight server import path.
WhisperEngine: Any | None = None


@dataclass(frozen=True, slots=True)
class _WhisperSettingsBridge:
    """Minimal Settings-shaped view consumed by the existing Whisper engine."""

    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    whisper_language: str | None
    whisper_beam_size: int
    whisper_temperature: float
    whisper_condition_on_previous_text: bool
    whisper_without_timestamps: bool
    whisper_vad_filter: bool
    whisper_vad_min_silence_duration_ms: int
    whisper_vad_speech_pad_ms: int
    whisper_vad_threshold: float


class _PreparedFasterWhisper:
    """Adapter-owned wrapper around the legacy ``WhisperEngine`` instance."""

    def __init__(self, engine: Any, info: ModelInfo) -> None:
        self._engine = engine
        self._info = info
        self._shutdown_lock = threading.Lock()
        self._shutdown = False

    @property
    def info(self) -> ModelInfo:
        return self._info

    def open_session(self) -> ModelSession:
        with self._shutdown_lock:
            if self._shutdown:
                raise RuntimeError("Prepared model has been shut down")
            return self._engine.create_session()

    def shutdown(self) -> None:
        with self._shutdown_lock:
            if self._shutdown:
                return
            self._shutdown = True
            engine = self._engine
        engine.shutdown()


class FasterWhisperAdapter(ModelAdapter):
    """Prepare Faster-Whisper models while retaining custom/local sources."""

    def __init__(
        self,
        *,
        catalog: tuple[ModelCatalogItem, ...] = FASTER_WHISPER_CATALOG,
    ) -> None:
        self._catalog = tuple(catalog)

    @property
    def catalog(self) -> tuple[ModelCatalogItem, ...]:
        """Presentation metadata; it does not constrain accepted model IDs."""

        return self._catalog

    def prepare(self, config: WhisperConfig, progress: ProgressSink) -> PreparedModel:
        _validate_config(config)
        candidate = ModelId(str(config.model))
        progress(
            PreparationProgress(
                candidate=candidate,
                phase="preparing",
                percent=0.0,
                detail="loading Faster-Whisper model",
            )
        )
        engine_cls = _get_whisper_engine()
        bridge = _WhisperSettingsBridge(
            whisper_model=str(config.model),
            whisper_device=config.device,
            whisper_compute_type=config.compute_type,
            whisper_language=config.language,
            whisper_beam_size=config.beam_size,
            whisper_temperature=config.temperature,
            whisper_condition_on_previous_text=config.condition_on_previous_text,
            whisper_without_timestamps=config.without_timestamps,
            whisper_vad_filter=config.vad_filter,
            whisper_vad_min_silence_duration_ms=config.vad_min_silence_duration_ms,
            whisper_vad_speech_pad_ms=config.vad_speech_pad_ms,
            whisper_vad_threshold=config.vad_threshold,
        )
        engine = engine_cls(bridge)
        info = _to_model_info(engine, config)
        progress(
            PreparationProgress(
                candidate=candidate,
                phase="ready",
                percent=100.0,
                detail="Faster-Whisper model ready",
            )
        )
        return _PreparedFasterWhisper(engine, info)


def _get_whisper_engine() -> Any:
    global WhisperEngine
    if WhisperEngine is None:
        try:
            from transcription.engines.whisper import WhisperEngine as engine_cls
        except ImportError as exc:
            raise RuntimeError(
                "Faster-Whisper adapter requires the faster-whisper dependency. "
                "Install with: uv sync --extra whisper"
            ) from exc
        WhisperEngine = engine_cls
    return WhisperEngine


def _to_model_info(engine: Any, config: WhisperConfig) -> ModelInfo:
    source = engine.engine_info
    languages_value = getattr(source, "languages", ("en",)) or ("en",)
    if isinstance(languages_value, str):
        languages = (languages_value,)
    else:
        languages = tuple(str(language) for language in languages_value)
    device = getattr(source, "device", None) or config.device
    if device not in {"auto", "cpu", "cuda"}:
        device = config.device
    size = getattr(source, "model_size_gb", None)
    if size is None:
        size = getattr(source, "size_gb", 0.0)
    load_time = getattr(source, "load_time_s", None)
    gpu_name = getattr(source, "gpu_name", None)
    gpu_vram_gb = getattr(source, "gpu_vram_gb", None)
    estimated_max_duration_s = getattr(source, "estimated_max_duration_s", None)
    if gpu_name is None or gpu_vram_gb is None or estimated_max_duration_s is None:
        capabilities = detect_gpu_capabilities(device)
        gpu_name = gpu_name or capabilities.name
        gpu_vram_gb = gpu_vram_gb if gpu_vram_gb is not None else capabilities.total_vram_gb
        if estimated_max_duration_s is None:
            estimated_max_duration_s = estimate_max_duration_s("whisper", gpu_vram_gb)
    return ModelInfo(
        model=ModelId(str(getattr(source, "model", config.model))),
        repo_id=getattr(source, "repo_id", None),
        model_path=getattr(source, "model_path", None),
        size_gb=float(size or 0.0),
        languages=languages,
        device=device,
        compute_type=str(getattr(source, "compute_type", None) or config.compute_type),
        cuda_active=bool(getattr(source, "cuda_active", False)),
        load_time_s=float(load_time or 0.0),
        supports_hotwords=bool(getattr(source, "supports_hotwords", True)),
        gpu_name=gpu_name,
        gpu_vram_gb=gpu_vram_gb,
        estimated_max_duration_s=estimated_max_duration_s,
        last_transcription_latency_s=getattr(source, "last_transcription_latency_s", None),
        vram_used_gb=getattr(source, "vram_used_gb", None),
    )


def _validate_config(config: WhisperConfig) -> None:
    if not str(config.model).strip():
        raise ValueError("Whisper model must not be empty")
    if config.device not in {"auto", "cpu", "cuda"}:
        raise ValueError(f"Unsupported Whisper device: {config.device!r}")
    if config.compute_type not in {"auto", "int8", "int8_float16", "float16", "float32"}:
        raise ValueError(f"Unsupported Whisper compute type: {config.compute_type!r}")
    if config.beam_size < 1:
        raise ValueError("Whisper beam size must be at least 1")
    if not 0.0 <= config.temperature <= 1.0:
        raise ValueError("Whisper temperature must be between 0 and 1")
    if config.vad_min_silence_duration_ms < 0:
        raise ValueError("Whisper VAD silence duration must not be negative")
    if config.vad_speech_pad_ms < 0:
        raise ValueError("Whisper VAD speech pad must not be negative")
    if not 0.0 <= config.vad_threshold <= 1.0:
        raise ValueError("Whisper VAD threshold must be between 0 and 1")


__all__ = ["FasterWhisperAdapter"]
