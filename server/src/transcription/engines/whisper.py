"""Faster-Whisper engine adapter."""

import logging
import os

from faster_whisper import WhisperModel
from numpy.typing import NDArray
import numpy as np

from transcription.base import EngineInfo
from transcription.model_download import is_repo_cached, update_model_download_state
from transcription.types import TranscribeResult

logger = logging.getLogger(__name__)

_NETWORK_ERROR_MARKERS = ("TLS", "SSL", "certificate", "ConnectionError", "urlopen")
_CUDA_DLL_ERROR_MARKERS = ("cublas", "cudart", "cufft", "cudnn", "cuda")
_MODEL_REPO_PREFIX = "Systran/faster-whisper-"


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
    return f"{_MODEL_REPO_PREFIX}{model}"


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
    def __init__(self, model: str, device: str, compute_type: str) -> None:
        model_size_gb = _MODEL_SIZES.get(model, 1.5)
        repo_id = _resolve_repo_id(model)
        preflight_cached: bool | None = None

        if repo_id:
            preflight_cached = is_repo_cached(repo_id)
            if preflight_cached:
                update_model_download_state(
                    model=model,
                    size_gb=model_size_gb,
                    status="ready",
                    cached=True,
                    detail="cached",
                )
            else:
                update_model_download_state(
                    model=model,
                    size_gb=model_size_gb,
                    status="downloading",
                    cached=False,
                    detail="download started",
                )
                logger.info(
                    "Whisper model not found in cache; downloading (~%.1f GB).", model_size_gb,
                )
        else:
            update_model_download_state(
                model=model,
                size_gb=model_size_gb,
                status="ready",
                cached=True,
                detail="local model",
            )

        logger.info(
            "Loading Whisper model: %s (device=%s, compute_type=%s)",
            model, device, compute_type,
        )
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
                    )
                raise
        self._model_name = model
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
        )

    def create_session(self) -> "WhisperSession":
        return WhisperSession(self._model)

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

        text_parts: list[str] = []
        total_prob = 0.0
        segment_count = 0
        last_speech_end: float | None = None

        for segment in segments:
            text_parts.append(segment.text.strip())
            total_prob += segment.avg_logprob
            segment_count += 1
            last_speech_end = segment.end

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
