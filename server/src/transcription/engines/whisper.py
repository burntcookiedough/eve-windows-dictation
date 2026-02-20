"""Faster-Whisper engine adapter."""

import logging

from faster_whisper import WhisperModel
from numpy.typing import NDArray
import numpy as np

from transcription.base import EngineInfo
from transcription.types import TranscribeResult

logger = logging.getLogger(__name__)

_NETWORK_ERROR_MARKERS = ("TLS", "SSL", "certificate", "ConnectionError", "urlopen")


def _is_network_error(exc: BaseException) -> bool:
    """Detect TLS/network errors that local-only loading can recover from."""
    for e in (exc, *getattr(exc, "__context__", ()), *getattr(exc, "__cause__", ())):
        msg = str(e)
        if any(marker.lower() in msg.lower() for marker in _NETWORK_ERROR_MARKERS):
            return True
    return False

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
                self._model = WhisperModel(
                    model, device=device, compute_type=compute_type,
                    local_files_only=True,
                )
            else:
                raise
        self._model_name = model
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
