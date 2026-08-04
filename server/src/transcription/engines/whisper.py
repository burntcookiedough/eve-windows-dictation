"""Faster-Whisper engine adapter."""

import logging
import os
import subprocess
import time
from dataclasses import dataclass
from typing import Callable

# Import torch first when available so its CUDA DLL directories are registered
# before CTranslate2 initializes inside faster-whisper.
try:
    import torch  # noqa: F401
except ImportError:
    pass

from faster_whisper import WhisperModel, download_model
from numpy.typing import NDArray
import numpy as np

from config import Settings
from transcription.base import EngineInfo
from transcription.model_download import (
    begin_model_download_progress,
    check_download_disk_space,
    DownloadDiskPreflightError,
    get_cached_required_bytes,
    get_repo_cache_status,
    mark_model_loading,
    track_huggingface_download_progress,
    update_model_download_state,
)
from transcription.types import TranscribeOptions, TranscribeResult, resolve_option

logger = logging.getLogger(__name__)

_NETWORK_ERROR_MARKERS = ("TLS", "SSL", "certificate", "ConnectionError", "urlopen")
_CUDA_DLL_ERROR_MARKERS = ("cublas", "cudart", "cufft", "cudnn", "cuda")
_MODEL_REPO_PREFIX = "Systran/faster-whisper-"
# This is the authoritative catalog for every built-in Whisper choice exposed
# through Settings. The values are Eve's known-public upstream repositories.
_PUBLIC_BUILTIN_MODELS = {
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "large-v3": "Systran/faster-whisper-large-v3",
    "medium": "Systran/faster-whisper-medium",
    "small": "Systran/faster-whisper-small",
    "tiny": "Systran/faster-whisper-tiny",
}


@dataclass(frozen=True)
class WhisperTranscribeOptions:
    language: str | None
    beam_size: int
    temperature: float
    condition_on_previous_text: bool
    without_timestamps: bool
    vad_filter: bool
    vad_parameters: dict[str, int | float]


def _iter_exception_chain(exc: BaseException) -> list[BaseException]:
    """Walk exception causes/contexts without raising on None."""
    seen: set[int] = set()
    stack = [exc]
    chain: list[BaseException] = []
    while stack:
        current = stack.pop()
        if current is None:
            continue
        current_id = id(current)
        if current_id in seen:
            continue
        seen.add(current_id)
        chain.append(current)
        stack.append(current.__context__)
        stack.append(current.__cause__)
    return chain


def _is_network_error(exc: BaseException) -> bool:
    """Detect TLS/network errors that local-only loading can recover from."""
    for e in _iter_exception_chain(exc):
        msg = str(e)
        if any(marker.lower() in msg.lower() for marker in _NETWORK_ERROR_MARKERS):
            return True
    return False


def _is_cuda_dll_error(exc: BaseException) -> bool:
    """Detect missing CUDA DLL errors for clearer startup diagnostics."""
    for e in _iter_exception_chain(exc):
        msg = str(e).lower()
        if any(marker in msg for marker in _CUDA_DLL_ERROR_MARKERS):
            return True
    return False


def _resolve_repo_id(model: str) -> str | None:
    if os.path.exists(model):
        return None
    if "/" in model:
        return model
    if model in _PUBLIC_BUILTIN_MODELS:
        return _PUBLIC_BUILTIN_MODELS[model]
    return f"{_MODEL_REPO_PREFIX}{model}"


def _download_repo(repo_id: str) -> str:
    """Download curated public models anonymously and preserve custom auth.

    ``huggingface_hub`` otherwise sends a saved token implicitly. A stale token
    can make a public repository return 401, so Eve's fixed curated catalog uses
    explicit anonymous access. Advanced/custom identifiers retain the library's
    existing authentication behavior.
    """
    if repo_id in _PUBLIC_BUILTIN_MODELS.values():
        return download_model(repo_id, use_auth_token=False)
    return download_model(repo_id)


def _get_cuda_active(device: str) -> bool:
    if device == "cpu":
        return False
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def _get_vram_used_gb() -> float | None:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    first = completed.stdout.strip().splitlines()[0] if completed.stdout.strip() else ""
    try:
        return round(float(first.strip()) / 1024.0, 3)
    except ValueError:
        return None


def _build_options(settings: Settings) -> WhisperTranscribeOptions:
    vad_parameters: dict[str, int | float] = {
        "min_silence_duration_ms": settings.whisper_vad_min_silence_duration_ms,
        "speech_pad_ms": settings.whisper_vad_speech_pad_ms,
        "threshold": settings.whisper_vad_threshold,
    }
    language = settings.whisper_language.strip() if settings.whisper_language else None
    return WhisperTranscribeOptions(
        language=language or None,
        beam_size=settings.whisper_beam_size,
        temperature=settings.whisper_temperature,
        condition_on_previous_text=settings.whisper_condition_on_previous_text,
        without_timestamps=settings.whisper_without_timestamps,
        vad_filter=settings.whisper_vad_filter,
        vad_parameters=vad_parameters,
    )


# Approximate on-disk model sizes in GB
_MODEL_SIZES: dict[str, float] = {
    "large-v3-turbo": 1.5,
    "large-v3": 2.9,
    "large-v2": 2.9,
    "medium": 1.4,
    "small": 0.5,
    "base": 0.1,
    "tiny": 0.07,
}


class WhisperEngine:
    def __init__(self, settings: Settings) -> None:
        model = settings.whisper_model
        device = settings.whisper_device
        compute_type = settings.whisper_compute_type
        model_size_gb = _MODEL_SIZES.get(model, 1.5)
        repo_id = _resolve_repo_id(model)
        cache_status = get_repo_cache_status(repo_id) if repo_id else None
        preflight_cached: bool | None = None
        model_source = model

        if repo_id:
            assert cache_status is not None
            preflight_cached = cache_status.status == "ready"
            if preflight_cached:
                model_source = cache_status.snapshot_path or model
                update_model_download_state(
                    model=model,
                    size_gb=model_size_gb,
                    status="ready",
                    cached=True,
                    detail="cached; loading model",
                    repo_id=repo_id,
                    path=cache_status.snapshot_path,
                    phase="loading",
                    progress_percent=100.0,
                )
            else:
                try:
                    check_download_disk_space(repo_id, model_size_gb)
                except DownloadDiskPreflightError as exc:
                    update_model_download_state(
                        model=model, size_gb=model_size_gb, status="error", cached=False,
                        detail=str(exc), repo_id=repo_id, path=cache_status.snapshot_path or cache_status.repo_path,
                        missing_files=cache_status.missing_files, partial_files=cache_status.partial_files, phase="error",
                    )
                    raise
                begin_model_download_progress(
                    model=model,
                    repo_id=repo_id,
                    size_gb=model_size_gb,
                    initial_bytes=get_cached_required_bytes(repo_id),
                )
                update_model_download_state(
                    model=model,
                    size_gb=model_size_gb,
                    status="downloading",
                    cached=False,
                    detail=f"download started ({cache_status.detail})",
                    repo_id=repo_id,
                    path=cache_status.snapshot_path or cache_status.repo_path,
                    missing_files=cache_status.missing_files,
                    partial_files=cache_status.partial_files,
                    phase="downloading",
                    progress_percent=0.0,
                )
                logger.info(
                    "Whisper model cache status is %s; loading may download (~%.1f GB).",
                    cache_status.status,
                    model_size_gb,
                )
        else:
            update_model_download_state(
                model=model,
                size_gb=model_size_gb,
                status="ready",
                cached=True,
                detail="local model; loading",
                path=model,
                phase="loading",
                progress_percent=100.0,
            )

        logger.info(
            "Loading Whisper model: %s (device=%s, compute_type=%s)",
            model, device, compute_type,
        )
        load_start = time.perf_counter()
        try:
            if repo_id and preflight_cached is False:
                with track_huggingface_download_progress():
                    model_source = _download_repo(repo_id)
                mark_model_loading()
            self._model = WhisperModel(
                model_source,
                device=device,
                compute_type=compute_type,
            )
        except Exception as exc:
            if _is_network_error(exc):
                logger.warning(
                    "Network/TLS error loading model, retrying with local cache: %s", exc,
                )
                try:
                    mark_model_loading()
                    self._model = WhisperModel(
                        model, device=device, compute_type=compute_type,
                        local_files_only=True,
                    )
                except Exception as fallback_exc:
                    update_model_download_state(
                        model=model,
                        size_gb=model_size_gb,
                        status="error",
                        cached=False,
                        detail="download failed: network error",
                        repo_id=repo_id,
                        phase="error",
                    )
                    raise fallback_exc from exc
            elif _is_cuda_dll_error(exc):
                logger.error(
                    "CUDA runtime DLLs missing while loading Whisper. "
                    "Install/update the NVIDIA driver or switch to CPU mode.",
                    exc_info=exc,
                )
                update_model_download_state(
                    model=model,
                    size_gb=model_size_gb,
                    status="error",
                    cached=preflight_cached,
                    detail="model loading failed: CUDA runtime unavailable",
                    repo_id=repo_id,
                    phase="error",
                )
                raise RuntimeError(
                    "CUDA runtime DLLs are missing. Install/update the NVIDIA driver or switch to CPU mode."
                ) from exc
            else:
                update_model_download_state(
                    model=model,
                    size_gb=model_size_gb,
                    status="error",
                    cached=preflight_cached,
                    detail=(
                        "download failed"
                        if preflight_cached is False
                        else "model loading failed"
                    ),
                    repo_id=repo_id,
                    phase="error",
                )
                raise
        self._load_time_s = time.perf_counter() - load_start
        self._model_name = model
        self._repo_id = repo_id
        self._model_path = (
            get_repo_cache_status(repo_id).snapshot_path if repo_id else model
        )
        self._device = device
        self._compute_type = compute_type
        self._cuda_active = _get_cuda_active(device)
        self._options = _build_options(settings)
        self._last_transcription_latency_s: float | None = None
        if preflight_cached is False:
            detail = "downloaded"
        elif preflight_cached is True:
            detail = "cached"
        else:
            detail = "local model"
        update_model_download_state(
            model=model,
            size_gb=model_size_gb,
            status="ready",
            cached=True,
            detail=detail,
            repo_id=repo_id,
            path=self._model_path,
            phase="ready",
            progress_percent=100.0,
        )
        if preflight_cached is False:
            logger.info("Whisper model download complete.")
        logger.info("Whisper model loaded successfully")

    @property
    def engine_info(self) -> EngineInfo:
        return EngineInfo(
            id="whisper",
            name="Faster-Whisper",
            model=self._model_name,
            supports_hotwords=True,
            languages=["en", "de", "fr", "es", "it", "ja", "zh", "nl", "ko", "pt"],
            model_size_gb=_MODEL_SIZES.get(self._model_name, 1.5),
            repo_id=self._repo_id,
            model_path=self._model_path,
            device=self._device,
            compute_type=self._compute_type,
            cuda_active=self._cuda_active,
            load_time_s=round(self._load_time_s, 3),
            last_transcription_latency_s=(
                round(self._last_transcription_latency_s, 3)
                if self._last_transcription_latency_s is not None else None
            ),
            vram_used_gb=_get_vram_used_gb(),
        )

    def create_session(self) -> "WhisperSession":
        return WhisperSession(
            self._model,
            self._options,
            lambda latency: setattr(self, "_last_transcription_latency_s", latency),
        )

    def shutdown(self) -> None:
        logger.info("Shutting down Whisper engine")
        del self._model
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass


class WhisperSession:
    def __init__(
        self,
        model: WhisperModel,
        options: WhisperTranscribeOptions,
        report_latency: Callable[[float], None],
    ) -> None:
        self._model = model
        self._options = options
        self._report_latency = report_latency
        self._last_result = TranscribeResult(text="", confidence=0.0, last_speech_end=None)

    def transcribe(
        self,
        audio: NDArray[np.float32],
        *,
        hotwords: str | None = None,
        options: TranscribeOptions | None = None,
    ) -> TranscribeResult:
        start = time.perf_counter()
        options = options or TranscribeOptions()
        condition_on_previous_text = resolve_option(
            self._options.condition_on_previous_text, options.condition_on_previous_text
        )
        without_timestamps = resolve_option(
            self._options.without_timestamps, options.without_timestamps
        )
        vad_filter = resolve_option(self._options.vad_filter, options.vad_filter)
        temperature = resolve_option(self._options.temperature, options.temperature)
        beam_size = resolve_option(self._options.beam_size, options.beam_size)
        segments, _info = self._model.transcribe(
            audio,
            language=self._options.language,
            hotwords=hotwords,
            beam_size=beam_size,
            temperature=temperature,
            condition_on_previous_text=condition_on_previous_text,
            without_timestamps=without_timestamps,
            vad_filter=vad_filter,
            vad_parameters=self._options.vad_parameters,
        )

        text_parts: list[str] = []
        total_prob = 0.0
        segment_count = 0
        last_speech_end: float | None = None

        for segment in segments:
            text_parts.append(segment.text.strip())
            total_prob += segment.avg_logprob
            segment_count += 1
            last_speech_end = segment.end
        self._report_latency(time.perf_counter() - start)

        text = " ".join(text_parts).strip()
        avg_confidence = 0.0
        if segment_count > 0:
            avg_log_prob = total_prob / segment_count
            avg_confidence = min(1.0, max(0.0, 1.0 + avg_log_prob / 2.0))

        self._last_result = TranscribeResult(
            text=text, confidence=avg_confidence, last_speech_end=last_speech_end,
        )
        return self._last_result

    def finalize(self) -> TranscribeResult:
        return self._last_result

    def close(self) -> None:
        pass
