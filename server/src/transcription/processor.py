"""Chunked transcription processing with partial result emission."""

import asyncio
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Awaitable, Callable, Final, TYPE_CHECKING

from perf_trace import ServerPerfTiming, is_perf_trace_enabled, sanitize_correlation_id
from audio.buffer import AudioBuffer
from config import get_settings
from protocol.constants import AUDIO_SAMPLE_RATE
from transcription.contracts import ModelSession, SessionId
from transcription.errors import VramExhaustedError
from transcription.factory import get_model_runtime
from transcription.long_dictation import plan_chunks, stitch_text
from transcription.types import TranscribeOptions, TranscribeResult

if TYPE_CHECKING:
    from session.context import SessionContext

logger = logging.getLogger(__name__)

# Bounded configuration invariants for inference memory safety
MAX_LONG_DICTATION_THRESHOLD_S: Final[float] = 120.0
MAX_LONG_DICTATION_CHUNK_S: Final[float] = 60.0
MIN_LONG_DICTATION_CHUNK_S: Final[float] = 1.0

# Shared thread pool for transcription
_executor: ThreadPoolExecutor | None = None
_executor_workers: int | None = None
_inference_lock: asyncio.Lock | None = None
_executor_config_lock: asyncio.Lock | None = None


def get_executor_config_lock() -> asyncio.Lock:
    global _executor_config_lock
    if _executor_config_lock is None:
        _executor_config_lock = asyncio.Lock()
    return _executor_config_lock


async def get_executor(max_workers: int) -> ThreadPoolExecutor:
    global _executor, _executor_workers
    async with get_executor_config_lock():
        if _executor is None or _executor_workers != max_workers:
            previous = _executor
            _executor = None
            _executor_workers = None
            if previous is not None:
                # Draining active native inference can take seconds. Keep that
                # wait off the event loop so health and WebSocket cleanup stay
                # responsive while settings from old/new sessions differ.
                await asyncio.to_thread(previous.shutdown, wait=True)
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
    perf: ServerPerfTiming | None = None


class TranscriptionProcessor:
    def __init__(self, context: "SessionContext") -> None:
        self._context = context
        self._settings = get_settings()
        runtime = get_model_runtime()
        self._lease = runtime.open_session(SessionId(context.session_id))
        self._session: ModelSession = self._lease.session
        self._session_id = context.session_id
        self._close_lock = threading.Lock()
        self._closed = False

    @property
    def _allow_overlapping_inference(self) -> bool:
        return bool(getattr(self._settings, "allow_overlapping_inference", False))

    @property
    def _transcription_max_workers(self) -> int:
        return int(getattr(self._settings, "transcription_max_workers", 1))

    @property
    def _long_dictation_threshold_s(self) -> float:
        val = float(getattr(self._settings, "long_dictation_threshold_s", 30.0))
        return min(val, MAX_LONG_DICTATION_THRESHOLD_S)

    @property
    def _long_dictation_chunk_s(self) -> float:
        val = float(getattr(self._settings, "long_dictation_chunk_s", 25.0))
        return max(MIN_LONG_DICTATION_CHUNK_S, min(val, MAX_LONG_DICTATION_CHUNK_S))

    @property
    def _long_dictation_overlap_s(self) -> float:
        val = float(getattr(self._settings, "long_dictation_overlap_s", 0.75))
        return max(0.0, min(val, 5.0))

    async def transcribe_partial(self) -> TranscriptionResult | None:
        if (
            self._context.audio_buffer.duration_seconds
            < self._settings.min_audio_for_transcription
        ):
            return None

        start_time = time.perf_counter()
        audio_duration = self._context.audio_buffer.duration_seconds
        loop = asyncio.get_running_loop()
        if audio_duration >= self._long_dictation_threshold_s:
            return await self._transcribe_long_partial_window(
                audio_duration=audio_duration,
                start_time=start_time,
                loop=loop,
            )

        audio = self._context.audio_buffer.get_audio_float32()

        if len(audio) == 0:
            return None

        if self._allow_overlapping_inference:
            executor = await get_executor(self._transcription_max_workers)
            result = await loop.run_in_executor(
                executor,
                lambda: self._session.transcribe(audio, hotwords=self._context.hotwords),
            )
        else:
            async with get_inference_lock():
                executor = await get_executor(1)
                result = await loop.run_in_executor(
                    executor,
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
        audio_buffer = self._context.audio_buffer
        audio_duration = audio_buffer.duration_seconds
        perf_collector: dict[str, float] | None = {} if is_perf_trace_enabled() else None

        if audio_duration <= 0.0:
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
                    audio_buffer,
                    progress_callback=progress_callback,
                    perf_collector=perf_collector,
                )
            else:
                audio = audio_buffer.get_audio_float32()
                if len(audio) == 0:
                    return TranscriptionResult(
                        text="",
                        confidence=0.0,
                        is_empty=True,
                        transcription_time=0.0,
                        audio_duration=0.0,
                        last_speech_end=None,
                    )
                result = await self._run_transcribe(
                    audio,
                    loop=loop,
                    perf_collector=perf_collector,
                )
        except VramExhaustedError as error:
            logger.warning(
                "[%s] VRAM exhausted during final transcription; "
                "returning last successful result",
                self._session_id,
            )
            result = error.last_result or self._session.finalize()

        transcription_time = time.perf_counter() - start_time

        perf: ServerPerfTiming | None = None
        if perf_collector is not None:
            stop_rcvd = getattr(self._context, "stop_received_at", None)
            last_audio = getattr(self._context, "last_audio_received_at", None)
            last_audio_offset = (
                (stop_rcvd - last_audio) * 1000.0
                if (stop_rcvd is not None and last_audio is not None)
                else None
            )
            perf = ServerPerfTiming(
                session_id=sanitize_correlation_id(self._context.trace_id),
                last_audio_offset_ms=round(last_audio_offset, 3) if last_audio_offset is not None else None,
                stop_to_lock_wait_ms=perf_collector.get("stop_to_lock_wait_ms"),
                lock_wait_ms=perf_collector.get("lock_wait_ms"),
                outstanding_partial_wait_ms=None,
                partial_task_active_at_stop=self._context.partial_task_active_at_stop,
                executor_queue_wait_ms=perf_collector.get("executor_queue_wait_ms"),
                final_inference_start_offset_ms=(perf_collector["inference_started_at"] - start_time) * 1000 if "inference_started_at" in perf_collector else None,
                final_inference_end_offset_ms=(perf_collector["inference_ended_at"] - start_time) * 1000 if "inference_ended_at" in perf_collector else None,
                model_inference_ms=perf_collector.get("model_inference_ms"),
            )

        return TranscriptionResult(
            text=result.text,
            confidence=result.confidence,
            is_empty=len(result.text.strip()) == 0,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
            last_speech_end=result.last_speech_end,
            perf=perf,
        )

    async def _transcribe_long_partial_window(
        self,
        *,
        audio_duration: float,
        start_time: float,
        loop: asyncio.AbstractEventLoop,
    ) -> TranscriptionResult | None:
        """Use a bounded tail window for speech timing after long mode starts.

        We intentionally suppress live text for long recordings. Re-emitting a
        whole-buffer partial after the threshold reintroduces the exact
        long-context drift that chunked final mode is designed to avoid.
        """
        max_samples = max(1, int(self._long_dictation_chunk_s * AUDIO_SAMPLE_RATE))
        window_audio = self._context.audio_buffer.get_audio_tail_float32(max_samples)
        if len(window_audio) == 0:
            return None
        window_start_sample = max(
            0,
            self._context.audio_buffer.sample_count - len(window_audio),
        )
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
        audio_buffer: AudioBuffer,
        *,
        progress_callback: Callable[[int, int], Awaitable[None]] | None,
        perf_collector: dict[str, float] | None = None,
    ) -> TranscribeResult:
        chunks = plan_chunks(
            audio_buffer,
            chunk_s=self._long_dictation_chunk_s,
            overlap_s=self._long_dictation_overlap_s,
        )
        if len(chunks) <= 1:
            loop = asyncio.get_running_loop()
            audio = audio_buffer.get_audio_float32()
            return await self._run_transcribe(audio, loop=loop, perf_collector=perf_collector)

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
            chunk_audio = audio_buffer.get_audio_range_float32(
                chunk.start_sample, chunk.end_sample
            )
            try:
                result = await self._run_transcribe(chunk_audio, loop=loop, options=options, perf_collector=perf_collector)
            except VramExhaustedError:
                logger.warning(
                    "[%s] VRAM exhausted during long dictation chunk %d/%d; "
                    "skipping failed chunk",
                    self._session_id,
                    chunk.index,
                    chunk.total,
                )
                result = TranscribeResult(
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
                        perf_collector=perf_collector,
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
                absolute_speech_end = chunk.start_s + result.last_speech_end
                last_speech_end = max(last_speech_end or 0.0, absolute_speech_end)

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
        perf_collector: dict[str, float] | None = None,
    ) -> TranscribeResult:
        if self._allow_overlapping_inference:
            executor = await get_executor(self._transcription_max_workers)
            if perf_collector is not None:
                t_q_start = time.perf_counter()
                def _worker_overlap():
                    t_exec = time.perf_counter()
                    q_wait = (t_exec - t_q_start) * 1000.0
                    t_inf = time.perf_counter()
                    res = self._call_session_transcribe(audio, options=options)
                    t_end = time.perf_counter()
                    perf_collector.setdefault("inference_started_at", t_inf)
                    perf_collector["inference_ended_at"] = t_end
                    return res, q_wait, (t_end - t_inf) * 1000.0
                res, q_wait, inf_ms = await loop.run_in_executor(executor, _worker_overlap)
                perf_collector["executor_queue_wait_ms"] = perf_collector.get("executor_queue_wait_ms", 0.0) + q_wait
                perf_collector["model_inference_ms"] = perf_collector.get("model_inference_ms", 0.0) + inf_ms
                return res
            return await loop.run_in_executor(
                executor,
                lambda: self._call_session_transcribe(audio, options=options),
            )

        t_lock_start = time.perf_counter() if perf_collector is not None else None
        if perf_collector is not None and self._context.stop_received_at is not None:
            perf_collector.setdefault("stop_to_lock_wait_ms", (t_lock_start - self._context.stop_received_at) * 1000)
        async with get_inference_lock():
            if perf_collector is not None:
                lock_wait = (time.perf_counter() - t_lock_start) * 1000.0
                perf_collector["lock_wait_ms"] = perf_collector.get("lock_wait_ms", 0.0) + lock_wait

            executor = await get_executor(1)
            if perf_collector is not None:
                t_q_start = time.perf_counter()
                def _worker_exclusive():
                    t_exec = time.perf_counter()
                    q_wait = (t_exec - t_q_start) * 1000.0
                    t_inf = time.perf_counter()
                    res = self._call_session_transcribe(audio, options=options)
                    t_end = time.perf_counter()
                    perf_collector.setdefault("inference_started_at", t_inf)
                    perf_collector["inference_ended_at"] = t_end
                    return res, q_wait, (t_end - t_inf) * 1000.0
                res, q_wait, inf_ms = await loop.run_in_executor(executor, _worker_exclusive)
                perf_collector["executor_queue_wait_ms"] = perf_collector.get("executor_queue_wait_ms", 0.0) + q_wait
                perf_collector["model_inference_ms"] = perf_collector.get("model_inference_ms", 0.0) + inf_ms
                return res

            return await loop.run_in_executor(
                executor,
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
        """Release the generation lease exactly once."""

        with self._close_lock:
            if self._closed:
                return
            self._closed = True
        self._lease.close()


def shutdown_executor() -> None:
    global _executor, _executor_workers, _inference_lock, _executor_config_lock
    if _executor is not None:
        _executor.shutdown(wait=True)
        _executor = None
        _executor_workers = None
    _inference_lock = None
    _executor_config_lock = None
