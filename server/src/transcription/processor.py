"""Chunked transcription processing with partial result emission."""

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Awaitable, Callable, TYPE_CHECKING

from config import get_settings
from protocol.constants import AUDIO_SAMPLE_RATE
from transcription.base import EngineSession
from transcription.errors import VramExhaustedError
from transcription.factory import get_engine_manager
from transcription.long_dictation import plan_chunks, stitch_text
from transcription.types import TranscribeOptions, TranscribeResult

if TYPE_CHECKING:
    from session.context import SessionContext

logger = logging.getLogger(__name__)

# Shared thread pool for transcription
_executor: ThreadPoolExecutor | None = None
_executor_workers: int | None = None
_inference_lock: asyncio.Lock | None = None


def get_executor(max_workers: int) -> ThreadPoolExecutor:
    global _executor, _executor_workers
    if _executor is None or _executor_workers != max_workers:
        if _executor is not None:
            _executor.shutdown(wait=True)
        _executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="transcribe",
        )
        _executor_workers = max_workers
    return _executor


def get_inference_lock() -> asyncio.Lock:
    global _inference_lock
    if _inference_lock is None:
        _inference_lock = asyncio.Lock()
    return _inference_lock


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
        self._session_id = context.session_id

    @property
    def _allow_overlapping_inference(self) -> bool:
        return bool(getattr(self._settings, "allow_overlapping_inference", False))

    @property
    def _transcription_max_workers(self) -> int:
        return int(getattr(self._settings, "transcription_max_workers", 1))

    @property
    def _long_dictation_threshold_s(self) -> float:
        return float(getattr(self._settings, "long_dictation_threshold_s", 30.0))

    @property
    def _long_dictation_chunk_s(self) -> float:
        return float(getattr(self._settings, "long_dictation_chunk_s", 25.0))

    @property
    def _long_dictation_overlap_s(self) -> float:
        return float(getattr(self._settings, "long_dictation_overlap_s", 0.75))

    async def transcribe_partial(self) -> TranscriptionResult | None:
        if (
            self._context.audio_buffer.duration_seconds
            < self._settings.min_audio_for_transcription
        ):
            return None

        start_time = time.perf_counter()
        audio_duration = self._context.audio_buffer.duration_seconds

        audio = self._context.audio_buffer.get_audio_float32()

        if len(audio) == 0:
            return None

        loop = asyncio.get_running_loop()
        if audio_duration >= self._long_dictation_threshold_s:
            return await self._transcribe_long_partial_window(
                audio,
                audio_duration=audio_duration,
                start_time=start_time,
                loop=loop,
            )

        if self._allow_overlapping_inference:
            result = await loop.run_in_executor(
                get_executor(self._transcription_max_workers),
                lambda: self._session.transcribe(audio, hotwords=self._context.hotwords),
            )
        else:
            async with get_inference_lock():
                result = await loop.run_in_executor(
                    get_executor(1),
                    lambda: self._session.transcribe(audio, hotwords=self._context.hotwords),
                )

        transcription_time = time.perf_counter() - start_time

        if result.text == self._context.last_partial_text:
            # Still update speech timing so silence monitor doesn't use stale data
            if (
                result.last_speech_end is not None
                and self._context.audio_start_time is not None
            ):
                self._context.last_speech_time = (
                    self._context.audio_start_time + result.last_speech_end
                )
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

    async def transcribe_final(
        self,
        progress_callback: Callable[[int, int], Awaitable[None]] | None = None,
    ) -> TranscriptionResult:
        start_time = time.perf_counter()
        audio_duration = self._context.audio_buffer.duration_seconds

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

        loop = asyncio.get_running_loop()
        try:
            if audio_duration >= self._long_dictation_threshold_s:
                result = await self._transcribe_long_final(
                    audio,
                    progress_callback=progress_callback,
                )
            else:
                result = await self._run_transcribe(audio, loop=loop)
        except VramExhaustedError as error:
            logger.warning(
                "[%s] VRAM exhausted during final transcription; "
                "returning last successful result",
                self._session_id,
            )
            result = error.last_result or self._session.finalize()

        transcription_time = time.perf_counter() - start_time

        return TranscriptionResult(
            text=result.text,
            confidence=result.confidence,
            is_empty=len(result.text.strip()) == 0,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
            last_speech_end=result.last_speech_end,
        )

    async def _transcribe_long_partial_window(
        self,
        audio,
        *,
        audio_duration: float,
        start_time: float,
        loop: asyncio.AbstractEventLoop,
    ) -> TranscriptionResult:
        """Use a bounded tail window for speech timing after long mode starts.

        We intentionally suppress live text for long recordings. Re-emitting a
        whole-buffer partial after the threshold reintroduces the exact
        long-context drift that chunked final mode is designed to avoid.
        """
        max_samples = max(1, int(self._long_dictation_chunk_s * AUDIO_SAMPLE_RATE))
        window_start_sample = max(0, len(audio) - max_samples)
        window_audio = audio[window_start_sample:]
        result = await self._run_transcribe(
            window_audio,
            loop=loop,
            options=TranscribeOptions(
                condition_on_previous_text=False,
                mode="long_chunk",
            ),
        )
        transcription_time = time.perf_counter() - start_time
        offset_s = window_start_sample / AUDIO_SAMPLE_RATE
        last_speech_end = (
            offset_s + result.last_speech_end
            if result.last_speech_end is not None
            else None
        )
        return TranscriptionResult(
            text="",
            confidence=result.confidence,
            is_empty=True,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
            last_speech_end=last_speech_end,
        )

    async def _transcribe_long_final(
        self,
        audio,
        *,
        progress_callback: Callable[[int, int], Awaitable[None]] | None,
    ) -> TranscribeResult:
        chunks = plan_chunks(
            audio,
            chunk_s=self._long_dictation_chunk_s,
            overlap_s=self._long_dictation_overlap_s,
        )
        if len(chunks) <= 1:
            loop = asyncio.get_running_loop()
            return await self._run_transcribe(audio, loop=loop)

        texts: list[str] = []
        total_weight = 0.0
        weighted_confidence = 0.0
        last_speech_end: float | None = None
        options = TranscribeOptions(
            condition_on_previous_text=False,
            without_timestamps=False,
            mode="long_chunk",
        )

        loop = asyncio.get_running_loop()
        for chunk in chunks:
            if progress_callback is not None:
                await progress_callback(chunk.index, chunk.total)
            chunk_audio = audio[chunk.start_sample:chunk.end_sample]
            try:
                result = await self._run_transcribe(chunk_audio, loop=loop, options=options)
            except VramExhaustedError as error:
                logger.warning(
                    "[%s] VRAM exhausted during long dictation chunk %d/%d; "
                    "using last available chunk result",
                    self._session_id,
                    chunk.index,
                    chunk.total,
                )
                result = error.last_result or TranscribeResult(
                    text="",
                    confidence=0.0,
                    last_speech_end=None,
                )
            if self._is_suspicious_long_chunk(result):
                retry_options = TranscribeOptions(
                    condition_on_previous_text=False,
                    without_timestamps=False,
                    temperature=0.0,
                    beam_size=3,
                    mode="long_chunk",
                )
                try:
                    retry_result = await self._run_transcribe(
                        chunk_audio,
                        loop=loop,
                        options=retry_options,
                    )
                except VramExhaustedError:
                    logger.warning(
                        "[%s] VRAM exhausted during long dictation retry %d/%d; "
                        "keeping first chunk result",
                        self._session_id,
                        chunk.index,
                        chunk.total,
                    )
                else:
                    if retry_result.confidence >= result.confidence or not result.text.strip():
                        result = retry_result
            texts.append(result.text)
            weight = max(0.001, chunk.logical_duration_s)
            weighted_confidence += result.confidence * weight
            total_weight += weight
            if result.last_speech_end is not None:
                last_speech_end = chunk.start_s + result.last_speech_end

        confidence = weighted_confidence / total_weight if total_weight > 0 else 0.0
        return TranscribeResult(
            text=stitch_text(texts),
            confidence=min(1.0, max(0.0, confidence)),
            last_speech_end=last_speech_end,
        )

    async def _run_transcribe(
        self,
        audio,
        *,
        loop: asyncio.AbstractEventLoop,
        options: TranscribeOptions | None = None,
    ) -> TranscribeResult:
        if self._allow_overlapping_inference:
            return await loop.run_in_executor(
                get_executor(self._transcription_max_workers),
                lambda: self._call_session_transcribe(audio, options=options),
            )

        async with get_inference_lock():
            return await loop.run_in_executor(
                get_executor(1),
                lambda: self._call_session_transcribe(audio, options=options),
            )

    def _call_session_transcribe(
        self,
        audio,
        *,
        options: TranscribeOptions | None = None,
    ) -> TranscribeResult:
        if options is None:
            return self._session.transcribe(audio, hotwords=self._context.hotwords)
        return self._session.transcribe(
            audio,
            hotwords=self._context.hotwords,
            options=options,
        )

    @staticmethod
    def _is_suspicious_long_chunk(result: TranscribeResult) -> bool:
        text = result.text.strip()
        if not text:
            return False
        return result.confidence < 0.35

    def close(self) -> None:
        self._session.close()
        get_engine_manager().release_session(self._session_id)


def shutdown_executor() -> None:
    global _executor, _executor_workers, _inference_lock
    if _executor is not None:
        _executor.shutdown(wait=True)
        _executor = None
        _executor_workers = None
    _inference_lock = None
