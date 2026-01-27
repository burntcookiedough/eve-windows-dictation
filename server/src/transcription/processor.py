"""Chunked transcription processing with partial result emission."""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import TYPE_CHECKING

from config import get_settings
from transcription.engine import get_engine

if TYPE_CHECKING:
    from session.context import SessionContext

logger = logging.getLogger(__name__)

# Shared thread pool for transcription
_executor: ThreadPoolExecutor | None = None


def get_executor() -> ThreadPoolExecutor:
    """Get the shared thread pool executor for transcription."""
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="transcribe")
    return _executor


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    """Result of a transcription operation."""

    text: str
    confidence: float
    is_empty: bool


class TranscriptionProcessor:
    """Handles transcription of audio from a session context."""

    def __init__(self, context: "SessionContext") -> None:
        """Initialize the processor.

        Args:
            context: Session context containing audio buffer.
        """
        self._context = context
        self._settings = get_settings()

    async def transcribe_partial(self) -> TranscriptionResult | None:
        """Transcribe current audio buffer for partial emission.

        Returns:
            TranscriptionResult if there's enough audio and new text,
            None if there's not enough audio or no change.
        """
        # Check minimum audio duration
        if (
            self._context.audio_buffer.duration_seconds
            < self._settings.min_audio_for_transcription
        ):
            return None

        # Get audio as float32 for Whisper
        audio = self._context.audio_buffer.get_audio_float32()
        if len(audio) == 0:
            return None

        # Run transcription in thread pool
        loop = asyncio.get_running_loop()
        engine = get_engine()

        result = await loop.run_in_executor(
            get_executor(),
            lambda: engine.transcribe(audio),
        )

        # Check if text changed from last partial
        if result.text == self._context.last_partial_text:
            return None

        # Update last partial
        self._context.last_partial_text = result.text

        return TranscriptionResult(
            text=result.text,
            confidence=result.confidence,
            is_empty=len(result.text.strip()) == 0,
        )

    async def transcribe_final(self) -> TranscriptionResult:
        """Transcribe final audio for session end.

        Returns:
            TranscriptionResult with final transcription.
        """
        # Get audio as float32 for Whisper
        audio = self._context.audio_buffer.get_audio_float32()

        if len(audio) == 0:
            return TranscriptionResult(text="", confidence=0.0, is_empty=True)

        # Run transcription in thread pool
        loop = asyncio.get_running_loop()
        engine = get_engine()

        result = await loop.run_in_executor(
            get_executor(),
            lambda: engine.transcribe(audio),
        )

        return TranscriptionResult(
            text=result.text,
            confidence=result.confidence,
            is_empty=len(result.text.strip()) == 0,
        )


def shutdown_executor() -> None:
    """Shutdown the transcription thread pool."""
    global _executor
    if _executor is not None:
        _executor.shutdown(wait=True)
        _executor = None
