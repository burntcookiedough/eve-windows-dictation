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

from faster_whisper import WhisperModel
from numpy.typing import NDArray
import numpy as np

from config import Settings
from transcription.base import EngineInfo
from transcription.model_download import get_repo_cache_status, update_model_download_state
from transcription.types import TranscribeResult

logger = logging.getLogger(__name__)

_NETWORK_ERROR_MARKERS = ("TLS", "SSL", "certificate", "ConnectionError", "urlopen")
_CUDA_DLL_ERROR_MARKERS = ("cublas", "cudart", "cufft", "cudnn", "cuda")
_MODEL_REPO_PREFIX = "Systran/faster-whisper-"
_MODEL_ALIASES = {
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
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
    if model in _MODEL_ALIASES:
        return _MODEL_ALIASES[model]
    return f"{_MODEL_REPO_PREFIX}{model}"


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

        if repo_id:
            assert cache_status is not None
            preflight_cached = cache_status.status == "ready"
            if preflight_cached:
                update_model_download_state(
                    model=model,
                    size_gb=model_size_gb,
                    status="ready",
                    cached=True,
                    detail=cache_status.detail,
                    repo_id=repo_id,
                    path=cache_status.snapshot_path,
                )
            else:
                status = "downloading" if cache_status.status == "downloading" else cache_status.status
                update_model_download_state(
                    model=model,
                    size_gb=model_size_gb,
                    status=status,
                    cached=False,
                    detail=cache_status.detail,
                    repo_id=repo_id,
                    path=cache_status.snapshot_path or cache_status.repo_path,
                    missing_files=cache_status.missing_files,
                    partial_files=cache_status.partial_files,
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
                detail="local model",
                path=model,
            )

        logger.info(
            "Loading Whisper model: %s (device=%s, compute_type=%s)",
            model, device, compute_type,
        )
        load_start = time.perf_counter()
        try:
            self._model = WhisperModel(model, device=device, compute_type=compute_type)
        except Exception as exc:
            if _is_network_error(exc):
                logger.warning(
                    "Network/TLS error loading model, retrying with local cache: %s", exc,
                )
                try:
                    self._model = WhisperModel(
                        model, device=device, compute_type=compute_type,
                        local_files_only=True,
                    )
                except Exception as fallback_exc:
                    if preflight_cached is False:
                        update_model_download_state(
                            model=model,
                            size_gb=model_size_gb,
                            status="error",
                            cached=False,
                            detail="download failed: network error",
                            repo_id=repo_id,
                        )
                    raise fallback_exc from exc
            elif _is_cuda_dll_error(exc):
                logger.error(
                    "CUDA runtime DLLs missing while loading Whisper. "
                    "Install/update the NVIDIA driver or switch to CPU mode.",
                    exc_info=exc,
                )
                raise RuntimeError(
                    "CUDA runtime DLLs are missing. Install/update the NVIDIA driver or switch to CPU mode."
                ) from exc
            else:
                if preflight_cached is False:
                    update_model_download_state(
                        model=model,
                        size_gb=model_size_gb,
                        status="error",
                        cached=False,
                        detail="download failed",
                        repo_id=repo_id,
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
    ) -> TranscribeResult:
        start = time.perf_counter()
        segments, info = self._model.transcribe(
            audio,
            language=self._options.language,
            hotwords=hotwords,
            beam_size=self._options.beam_size,
            temperature=self._options.temperature,
            condition_on_previous_text=self._options.condition_on_previous_text,
            without_timestamps=self._options.without_timestamps,
            vad_filter=self._options.vad_filter,
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
