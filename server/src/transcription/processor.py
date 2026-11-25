"""Incremental transcription: commit sealed audio while recording, finalize the tail."""

import asyncio
import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, replace
from typing import Awaitable, Callable, Final, TYPE_CHECKING, TypeVar

from perf_trace import ServerPerfTiming, is_perf_trace_enabled, sanitize_correlation_id
from config import get_settings
from protocol.constants import AUDIO_SAMPLE_RATE
from transcription.contracts import ModelSession, SessionId
from transcription.errors import IncompleteTranscriptionError, VramExhaustedError
from transcription.factory import get_model_runtime
from transcription.incremental import CommittedTranscript, Decode, is_settled, plan_seal
from transcription.long_dictation import AudioChunk, plan_chunks, stitch_text
from transcription.types import TranscribeOptions, TranscribeResult

if TYPE_CHECKING:
    from session.context import SessionContext

logger = logging.getLogger(__name__)

# Bounded configuration invariants for inference memory safety
MAX_LONG_DICTATION_THRESHOLD_S: Final[float] = 120.0
_Result = TypeVar("_Result")
MAX_LONG_DICTATION_CHUNK_S: Final[float] = 60.0
MIN_LONG_DICTATION_CHUNK_S: Final[float] = 1.0
# Look for a pause to seal once this fraction of a long chunk is uncommitted.
SEAL_AFTER_FRACTION: Final[float] = 0.4

_LONG_CHUNK_OPTIONS: Final = TranscribeOptions(
    condition_on_previous_text=False,
    without_timestamps=False,
    mode="long_chunk",
)
_RETRY_OPTIONS: Final = TranscribeOptions(
    condition_on_previous_text=False,
    without_timestamps=False,
    temperature=0.0,
    beam_size=3,
    mode="long_chunk",
)
# Speech-timing window for long recordings without a reusable tail decode.
_LONG_PARTIAL_OPTIONS: Final = TranscribeOptions(
    condition_on_previous_text=False,
    mode="long_chunk",
)

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
        self._pending_inference = 0
        self._lease_release: asyncio.Future[None] | None = None
        # One background job (commit or partial) or the final runs at a time,
        # so the final waits for at most one bounded job.
        self._work_lock = asyncio.Lock()
        self._finalizing = False
        self._committed = CommittedTranscript()
        self._tail: Decode | None = None  # latest decode of the uncommitted tail
        self._last_job_committed = False
        self._commit_disabled = False
        self._reported_speech_end: float | None = None  # absolute, for monotonic timing

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

    @property
    def _incremental(self) -> bool:
        enabled = bool(getattr(self._settings, "incremental_commit", True))
        return enabled and not self._commit_disabled

    async def transcribe_partial(self) -> TranscriptionResult | None:
        """Run at most one bounded background job: a commit, a partial, or nothing."""
        audio_buffer = self._context.audio_buffer
        if audio_buffer.duration_seconds < self._settings.min_audio_for_transcription:
            return None
        if self._finalizing:
            return None
        async with self._work_lock:
            # Stop may have arrived while this job waited for the previous one.
            if self._finalizing:
                return None
            start_time = time.perf_counter()
            total = audio_buffer.sample_count
            if self._incremental:
                # Alternate with partials so speech timing never starves.
                seal = None if self._last_job_committed else self._plan_seal(total)
                if seal is not None:
                    self._last_job_committed = True
                    await self._commit(*seal)
                    return self._commit_speech_timing(total, start_time)
                self._last_job_committed = False
                if self._tail is not None and is_settled(audio_buffer, self._tail, total):
                    # Only silence since the last decode: nothing new to hear.
                    return None
            return await self._transcribe_tail_partial(total, start_time)

    async def _transcribe_tail_partial(
        self, total: int, start_time: float,
    ) -> TranscriptionResult | None:
        audio_duration = total / AUDIO_SAMPLE_RATE
        long_mode = audio_duration >= self._long_dictation_threshold_s
        tail = self._committed.tail_chunk(total)
        window, options = tail, self._tail_options(tail)
        max_samples = max(1, int(self._long_dictation_chunk_s * AUDIO_SAMPLE_RATE))
        capped = long_mode and tail.end_sample - tail.start_sample > max_samples
        if capped:
            begin = total - max_samples
            window = AudioChunk(1, 1, begin, total, begin, total)
        if long_mode and (capped or not self._incremental):
            options = _LONG_PARTIAL_OPTIONS
        if window.end_sample <= window.start_sample:
            return None
        audio = self._context.audio_buffer.get_audio_range_float32(
            window.start_sample, window.end_sample,
        )
        if len(audio) == 0:
            return None

        result = await self._run_transcribe(audio, loop=asyncio.get_running_loop(), options=options)
        transcription_time = time.perf_counter() - start_time
        decode = Decode(window, result)
        if self._incremental and not capped:
            self._tail = decode
        last_speech_end = (
            window.start_s + result.last_speech_end
            if result.last_speech_end is not None
            else None
        )
        if last_speech_end is not None:
            # A window that hears speech only in its overlap must not rewind
            # the silence monitor's speech time.
            last_speech_end = max(self._reported_speech_end or 0.0, last_speech_end)
            self._reported_speech_end = last_speech_end

        if long_mode:
            # Live text stays suppressed in long mode; whole-recording partial
            # text is not shown. The bounded decode still drives speech timing.
            return TranscriptionResult(
                text="",
                confidence=result.confidence,
                is_empty=True,
                transcription_time=transcription_time,
                audio_duration=audio_duration,
                last_speech_end=last_speech_end,
            )

        text = (
            stitch_text([self._committed.text, self._committed.text_for(decode)])
            if self._committed.texts
            else result.text
        )
        if text == self._context.last_partial_text:
            # Still update speech timing so silence monitor doesn't use stale data
            if last_speech_end is not None and self._context.audio_start_time is not None:
                self._context.last_speech_time = self._context.audio_start_time + last_speech_end
            return None

        self._context.last_partial_text = text
        return TranscriptionResult(
            text=text,
            confidence=result.confidence,
            is_empty=len(text.strip()) == 0,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
            last_speech_end=last_speech_end,
        )

    def _commit_speech_timing(self, total: int, start_time: float) -> TranscriptionResult | None:
        """Let a commit advance speech timing, never move it backwards.

        Continuous speech on a slow CPU can run several commits between
        partials; without this the silence monitor would see stale speech.
        """
        speech_end = self._committed.last_speech_end
        if speech_end is None or speech_end <= (self._reported_speech_end or 0.0):
            return None
        self._reported_speech_end = speech_end
        return TranscriptionResult(
            text="",
            confidence=0.0,
            is_empty=True,
            transcription_time=time.perf_counter() - start_time,
            audio_duration=total / AUDIO_SAMPLE_RATE,
            last_speech_end=speech_end,
        )

    def _plan_seal(self, total: int) -> tuple[AudioChunk, int] | None:
        chunk_s = self._long_dictation_chunk_s
        return plan_seal(
            self._context.audio_buffer,
            committed_end=self._committed.end_sample,
            overlap_samples=self._committed.overlap_samples,
            total_samples=total,
            seal_after_s=SEAL_AFTER_FRACTION * chunk_s,
            chunk_s=chunk_s,
            overlap_s=self._long_dictation_overlap_s,
        )

    async def _commit(self, chunk: AudioChunk, next_overlap: int) -> None:
        """Decode a sealed chunk once and append it to the committed text."""
        audio = self._context.audio_buffer.get_audio_range_float32(
            chunk.start_sample, chunk.end_sample,
        )
        try:
            result, failure = await self._decode_long_chunk(
                audio, loop=asyncio.get_running_loop(), for_commit=True,
            )
            if failure is not None:
                raise failure
        except Exception:
            # Never commit failed or recovered work. The final decodes this
            # audio again as part of the tail and reports its own outcome.
            self._commit_disabled = True
            logger.warning("[%s] Incremental commit failed; final will decode the tail", self._session_id)
            raise
        if result is None:
            return  # Stop arrived before a needed retry; the final owns this audio.
        self._committed.append(Decode(chunk, result))
        self._committed.overlap_samples = next_overlap
        self._tail = None

    @staticmethod
    def _tail_options(tail: AudioChunk) -> TranscribeOptions | None:
        # Overlap dedupe needs segment timestamps; otherwise keep engine defaults.
        return _LONG_CHUNK_OPTIONS if tail.start_sample < tail.logical_start_sample else None

    async def transcribe_final(
        self,
        progress_callback: Callable[[int, int], Awaitable[None]] | None = None,
    ) -> TranscriptionResult:
        start_time = time.perf_counter()
        audio_buffer = self._context.audio_buffer
        perf_collector: dict[str, float] | None = {} if is_perf_trace_enabled() else None
        stop_received_at = getattr(self._context, "stop_received_at", None)
        if perf_collector is not None and stop_received_at is not None:
            perf_collector["stop_to_lock_wait_ms"] = (start_time - stop_received_at) * 1000

        # No new background job starts; wait for the one bounded job in flight.
        self._finalizing = True
        async with self._work_lock:
            outstanding_ms = (time.perf_counter() - start_time) * 1000.0
            if perf_collector is not None:
                perf_collector["outstanding_partial_wait_ms"] = outstanding_ms
                perf_collector["lock_wait_ms"] = outstanding_ms

            audio_duration = audio_buffer.duration_seconds
            if audio_duration <= 0.0:
                return TranscriptionResult(
                    text="",
                    confidence=0.0,
                    is_empty=True,
                    transcription_time=0.0,
                    audio_duration=0.0,
                    last_speech_end=None,
                )
            try:
                result = await self._transcribe_final_tail(
                    progress_callback=progress_callback,
                    perf_collector=perf_collector,
                )
            except VramExhaustedError:
                logger.warning(
                    "[%s] VRAM exhausted during final transcription; "
                    "available result is incomplete",
                    self._session_id,
                )
                raise

        transcription_time = time.perf_counter() - start_time

        perf: ServerPerfTiming | None = None
        if perf_collector is not None:
            last_audio = getattr(self._context, "last_audio_received_at", None)
            last_audio_offset = (
                (stop_received_at - last_audio) * 1000.0
                if (stop_received_at is not None and last_audio is not None)
                else None
            )
            perf = ServerPerfTiming(
                session_id=sanitize_correlation_id(self._context.trace_id),
                last_audio_offset_ms=round(last_audio_offset, 3) if last_audio_offset is not None else None,
                stop_to_lock_wait_ms=perf_collector.get("stop_to_lock_wait_ms"),
                lock_wait_ms=perf_collector.get("lock_wait_ms"),
                outstanding_partial_wait_ms=perf_collector.get("outstanding_partial_wait_ms"),
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

    async def _transcribe_final_tail(
        self,
        *,
        progress_callback: Callable[[int, int], Awaitable[None]] | None,
        perf_collector: dict[str, float] | None,
    ) -> TranscribeResult:
        """Committed text plus the uncommitted tail, decoded at most once more."""
        audio_buffer = self._context.audio_buffer
        total = audio_buffer.sample_count
        state = self._committed.copy()
        tail = state.tail_chunk(total)
        if tail.end_sample <= tail.logical_start_sample:
            return state.to_result()

        cached = self._tail
        if (
            self._incremental
            and cached is not None
            # A decode that heard no uncommitted speech (none at all, or only
            # in a forced-seal overlap) proves nothing about quiet speech
            # after it; decoding the tail on stop is cheap in that case.
            and cached.result.last_speech_end is not None
            and cached.chunk.start_sample
            + int(cached.result.last_speech_end * AUDIO_SAMPLE_RATE)
            > tail.logical_start_sample
            and cached.chunk.start_sample == tail.start_sample
            and is_settled(audio_buffer, cached, total)
        ):
            # The latest decode already heard everything but trailing silence.
            state.append(cached)
            return state.to_result()

        if tail.duration_s >= self._long_dictation_threshold_s:
            chunks = plan_chunks(
                audio_buffer,
                chunk_s=self._long_dictation_chunk_s,
                overlap_s=self._long_dictation_overlap_s,
                start_sample=tail.logical_start_sample,
                end_sample=total,
            )
            if len(chunks) > 1:
                chunks[0] = replace(chunks[0], start_sample=tail.start_sample)
                return await self._transcribe_chunks(
                    state, chunks, progress_callback=progress_callback, perf_collector=perf_collector,
                )

        audio = audio_buffer.get_audio_range_float32(tail.start_sample, total)
        if len(audio) == 0:
            return state.to_result()
        try:
            result = await self._run_transcribe(
                audio,
                loop=asyncio.get_running_loop(),
                options=self._tail_options(tail),
                perf_collector=perf_collector,
            )
        except IncompleteTranscriptionError as error:
            if state.texts:
                recovered = error.last_result or TranscribeResult(text="", confidence=0.0, last_speech_end=None)
                state.append(Decode(tail, recovered))
                error.last_result = state.to_result()
            raise
        state.append(Decode(tail, result))
        return state.to_result()

    async def _transcribe_chunks(
        self,
        state: CommittedTranscript,
        chunks: list[AudioChunk],
        *,
        progress_callback: Callable[[int, int], Awaitable[None]] | None,
        perf_collector: dict[str, float] | None,
    ) -> TranscribeResult:
        loop = asyncio.get_running_loop()
        audio_buffer = self._context.audio_buffer
        for chunk in chunks:
            if progress_callback is not None:
                await progress_callback(chunk.index, chunk.total)
            chunk_audio = audio_buffer.get_audio_range_float32(
                chunk.start_sample, chunk.end_sample
            )
            try:
                result, failure = await self._decode_long_chunk(
                    chunk_audio, loop=loop, perf_collector=perf_collector,
                )
            except Exception as error:
                raise IncompleteTranscriptionError(
                    "Long transcription failed; completed chunks are incomplete output.",
                    last_result=TranscribeResult(state.text, 0.0, state.last_speech_end),
                ) from error
            assert result is not None
            # Only current-call work belongs to this chunk. Never reuse a
            # previous chunk's session.finalize() result at a new offset.
            state.append(Decode(chunk, result))
            if failure is not None:
                failure.last_result = state.to_result()
                raise failure
        return state.to_result()

    async def _decode_long_chunk(
        self,
        chunk_audio,
        *,
        loop: asyncio.AbstractEventLoop,
        perf_collector: dict[str, float] | None = None,
        for_commit: bool = False,
    ) -> tuple[TranscribeResult | None, IncompleteTranscriptionError | None]:
        """Decode one long chunk, retrying a suspicious result with safer options.

        ``for_commit`` marks a background commit, whose result becomes
        permanent. It returns ``(None, None)`` when stop arrived before a needed
        retry, so a commit stays bounded to one decode once the final is
        waiting, and it reports a retry that ran out of VRAM as a failure
        instead of keeping the suspicious first pass.
        """
        failure: IncompleteTranscriptionError | None = None
        try:
            result = await self._run_transcribe(
                chunk_audio, loop=loop, options=_LONG_CHUNK_OPTIONS, perf_collector=perf_collector,
            )
        except IncompleteTranscriptionError as error:
            failure = error
            result = error.last_result or TranscribeResult(
                text="",
                confidence=0.0,
                last_speech_end=None,
            )
        if failure is None and self._is_suspicious_long_chunk(result):
            if for_commit and self._finalizing:
                return None, None
            try:
                retry_result = await self._run_transcribe(
                    chunk_audio,
                    loop=loop,
                    options=_RETRY_OPTIONS,
                    perf_collector=perf_collector,
                )
            except VramExhaustedError as error:
                if for_commit:
                    # Never make a suspicious first pass permanent; the final
                    # decodes this range and keeps its own OOM behaviour.
                    return result, error
                logger.warning(
                    "[%s] VRAM exhausted during long dictation retry; "
                    "keeping first chunk result",
                    self._session_id,
                )
            except IncompleteTranscriptionError as error:
                # The first pass covered this chunk. Preserve it as well
                # as prior chunks when a non-OOM retry fails.
                failure = error
            except Exception as error:
                failure = IncompleteTranscriptionError(
                    "Long transcription retry failed; available text is incomplete.",
                )
                failure.__cause__ = error
            else:
                if retry_result.confidence >= result.confidence or not result.text.strip():
                    result = retry_result
        return result, failure

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
                res, q_wait, inf_ms = await self._submit_inference(executor, _worker_overlap, loop=loop)
                perf_collector["executor_queue_wait_ms"] = perf_collector.get("executor_queue_wait_ms", 0.0) + q_wait
                perf_collector["model_inference_ms"] = perf_collector.get("model_inference_ms", 0.0) + inf_ms
                return res
            return await self._submit_inference(
                executor,
                lambda: self._call_session_transcribe(audio, options=options),
                loop=loop,
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
                res, q_wait, inf_ms = await self._submit_inference(executor, _worker_exclusive, loop=loop)
                perf_collector["executor_queue_wait_ms"] = perf_collector.get("executor_queue_wait_ms", 0.0) + q_wait
                perf_collector["model_inference_ms"] = perf_collector.get("model_inference_ms", 0.0) + inf_ms
                return res

            return await self._submit_inference(
                executor,
                lambda: self._call_session_transcribe(audio, options=options),
                loop=loop,
            )

    async def _submit_inference(
        self,
        executor: ThreadPoolExecutor,
        work: Callable[[], _Result],
        *,
        loop: asyncio.AbstractEventLoop,
    ) -> _Result:
        # Reserve before submit: queued jobs own the lease too. Cancellation of
        # an asyncio await does not mean that a running native job has stopped.
        with self._close_lock:
            if self._closed:
                raise RuntimeError("Transcription processor is closed")
            self._pending_inference += 1
        try:
            future = executor.submit(work)
        except BaseException:
            self._inference_finished()
            raise
        future.add_done_callback(self._inference_finished)
        return await asyncio.wrap_future(future, loop=loop)

    def _inference_finished(self, _future: Future | None = None) -> None:
        with self._close_lock:
            self._pending_inference -= 1
            release = self._closed and self._pending_inference == 0
        if release:
            # A queued job can be cancelled on the event-loop thread. Closing
            # a retired generation can unload native memory; keep that off-loop.
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                self._lease.close()
            else:
                self._lease_release = loop.run_in_executor(None, self._lease.close)
                self._lease_release.add_done_callback(self._report_lease_release)

    @staticmethod
    def _report_lease_release(future: asyncio.Future[None]) -> None:
        if not future.cancelled() and future.exception() is not None:
            logger.error("Deferred model lease release failed", exc_info=future.exception())

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
        """Release the lease after all submitted native work has actually ended."""

        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            release = self._pending_inference == 0
        if release:
            self._lease.close()


def shutdown_executor() -> None:
    global _executor, _executor_workers, _inference_lock, _executor_config_lock
    if _executor is not None:
        _executor.shutdown(wait=True)
        _executor = None
        _executor_workers = None
    _inference_lock = None
    _executor_config_lock = None
