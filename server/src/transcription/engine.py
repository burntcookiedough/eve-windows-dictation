"""Whisper transcription engine singleton."""

import logging
import threading
from dataclasses import dataclass

from faster_whisper import WhisperModel
from numpy.typing import NDArray

from config import Settings, get_settings

logger = logging.getLogger(__name__)

# Global engine instance
_engine: "WhisperEngine | None" = None
_engine_lock = threading.Lock()


@dataclass(frozen=True, slots=True)
class TranscribeResult:
    """Result of a transcription."""

    text: str
    confidence: float


class WhisperEngine:
    """Singleton wrapper around faster-whisper model."""

    def __init__(self, settings: Settings) -> None:
        """Initialize the Whisper model.

        Args:
            settings: Application settings.
        """
        logger.info(
            "Loading Whisper model: %s (device=%s, compute_type=%s)",
            settings.whisper_model,
            settings.whisper_device,
            settings.whisper_compute_type,
        )

        self._model = WhisperModel(
            settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
        )

        logger.info("Whisper model loaded successfully")

    def transcribe(
        self,
        audio: NDArray,
        *,
        language: str | None = None,
    ) -> TranscribeResult:
        """Transcribe audio samples.

        Args:
            audio: Audio samples as float32 normalized to [-1.0, 1.0].
            language: Optional language code (e.g., "en"). Auto-detect if None.

        Returns:
            TranscribeResult with text and confidence score.
        """
        segments, info = self._model.transcribe(
            audio,
            language=language,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            without_timestamps=True,
        )

        # Collect all segments
        text_parts = []
        total_prob = 0.0
        segment_count = 0

        for segment in segments:
            text_parts.append(segment.text.strip())
            total_prob += segment.avg_logprob
            segment_count += 1

        text = " ".join(text_parts).strip()
        # Convert log probability to confidence (0-1 range)
        avg_confidence = 0.0
        if segment_count > 0:
            avg_log_prob = total_prob / segment_count
            # Log prob is typically negative, closer to 0 is better
            # Map roughly to 0-1 range
            avg_confidence = min(1.0, max(0.0, 1.0 + avg_log_prob / 2.0))

        return TranscribeResult(text=text, confidence=avg_confidence)


def get_engine() -> WhisperEngine:
    """Get the global WhisperEngine instance, creating it if needed."""
    global _engine

    if _engine is not None:
        return _engine

    with _engine_lock:
        # Double-check after acquiring lock
        if _engine is not None:
            return _engine

        _engine = WhisperEngine(get_settings())
        return _engine


def shutdown_engine() -> None:
    """Shutdown the global WhisperEngine instance."""
    global _engine

    with _engine_lock:
        if _engine is not None:
            logger.info("Shutting down Whisper engine")
            _engine = None
