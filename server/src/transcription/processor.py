"""Chunked transcription processing with partial result emission."""

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import TYPE_CHECKING

from config import get_settings
from transcription.base import AudioMode, EngineSession
from transcription.factory import get_engine_manager

if TYPE_CHECKING:
    from session.context import SessionContext

logger = logging.getLogger(__name__)

# Shared thread pool for transcription
_executor: ThreadPoolExecutor | None = None


def get_executor() -> ThreadPoolExecutor:
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="transcribe")
    return _executor


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    text: str
    confidence: float
    is_empty: bool
    transcription_time: float
    audio_duration: float
    last_speech_end: float | None


class TranscriptionProcessor:
    def __init__(self, context: "SessionContext") -> None:
        self._context = context
        self._settings = get_settings()

        manager = get_engine_manager()
        self._session: EngineSession = manager.create_session(context.session_id)
        self._audio_mode = manager.audio_mode
        self._session_id = context.session_id

    @property
    def audio_mode(self) -> AudioMode:
        return self._audio_mode

    async def transcribe_partial(self) -> TranscriptionResult | None:
        # Minimum duration check only for full-buffer mode
        if self._audio_mode == AudioMode.FULL_BUFFER:
            if (
                self._context.audio_buffer.duration_seconds
                < self._settings.min_audio_for_transcription
            ):
                return None

        start_time = time.perf_counter()
        audio_duration = self._context.audio_buffer.duration_seconds

        if self._audio_mode == AudioMode.FULL_BUFFER:
            audio = self._context.audio_buffer.get_audio_float32()
        else:
            audio = self._context.audio_buffer.get_new_audio_float32()

        if len(audio) == 0:
            return None

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            get_executor(),
            lambda: self._session.transcribe(audio, hotwords=self._context.hotwords),
        )

        transcription_time = time.perf_counter() - start_time

        if result.text == self._context.last_partial_text:
            return None

        self._context.last_partial_text = result.text

        return TranscriptionResult(
            text=result.text,
            confidence=result.confidence,
            is_empty=len(result.text.strip()) == 0,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
            last_speech_end=result.last_speech_end,
        )

    async def transcribe_final(self) -> TranscriptionResult:
        start_time = time.perf_counter()
        audio_duration = self._context.audio_buffer.duration_seconds

        loop = asyncio.get_running_loop()

        if self._audio_mode == AudioMode.FULL_BUFFER:
            audio = self._context.audio_buffer.get_audio_float32()
            if len(audio) == 0:
                return TranscriptionResult(
                    text="",
                    confidence=0.0,
                    is_empty=True,
                    transcription_time=0.0,
                    audio_duration=0.0,
                    last_speech_end=None,
                )
            result = await loop.run_in_executor(
                get_executor(),
                lambda: self._session.transcribe(audio, hotwords=self._context.hotwords),
            )
        else:
            # For incremental engines: pass the full audio buffer so finalize
            # can do a fresh batch pass for higher quality final text
            full_audio = self._context.audio_buffer.get_audio_float32()
            result = await loop.run_in_executor(
                get_executor(),
                lambda: self._session.finalize(full_audio=full_audio),
            )

        transcription_time = time.perf_counter() - start_time

        return TranscriptionResult(
            text=result.text,
            confidence=result.confidence,
            is_empty=len(result.text.strip()) == 0,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
            last_speech_end=result.last_speech_end,
        )

    def close(self) -> None:
        self._session.close()
        get_engine_manager().release_session(self._session_id)


def shutdown_executor() -> None:
    global _executor
    if _executor is not None:
        _executor.shutdown(wait=True)
        _executor = None
