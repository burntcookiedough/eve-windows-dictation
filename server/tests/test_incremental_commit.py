"""Incremental commit: sealed audio is decoded once while recording; stop decodes the tail."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import numpy as np
import pytest

from audio.buffer import AudioBuffer
import transcription.processor as processor_module
from transcription.errors import IncompleteTranscriptionError, VramExhaustedError
from transcription.incremental import CommittedTranscript, Decode, is_settled, plan_seal
from transcription.long_dictation import AudioChunk
from transcription.types import TranscribeOptions, TranscribeResult, TranscribeSegment

RATE = 16000
WORD_S = 0.3
WORD_GAP_S = 0.12  # Inside a phrase: far shorter than a sealable pause.
PAUSE_S = 0.8  # Between phrases.
VAD_PAD_S = 0.2
BASE_AMP = 2000
AMP_STEP = 250
ACTIVE_RMS = 500.0 / 32768.0


def _settings(**overrides: object) -> SimpleNamespace:
    values = {
        "min_audio_for_transcription": 0.1,
        "allow_overlapping_inference": False,
        "transcription_max_workers": 1,
        "long_dictation_threshold_s": 30.0,
        "long_dictation_chunk_s": 25.0,
        "long_dictation_overlap_s": 0.75,
        "incremental_commit": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _speech(phrases: list[int], *, pause_s: float = PAUSE_S, trailing_s: float = 0.0) -> tuple[np.ndarray, str]:
    """Synthetic speech: each word is a square-wave burst whose amplitude is its id."""
    rng = np.random.default_rng(7)
    parts: list[np.ndarray] = []
    words: list[str] = []

    def quiet(seconds: float) -> None:
        parts.append(rng.integers(-30, 31, int(seconds * RATE)).astype(np.int16))

    word_id = 0
    for phrase_index, length in enumerate(phrases):
        if phrase_index:
            quiet(pause_s)
        for position in range(length):
            if position:
                quiet(WORD_GAP_S)
            amplitude = BASE_AMP + AMP_STEP * (word_id % 100)
            burst = np.full(int(WORD_S * RATE), amplitude, dtype=np.int16)
            burst[1::2] *= -1
            parts.append(burst)
            words.append(f"w{word_id % 100}")
            word_id += 1
    quiet(trailing_s)
    return np.concatenate(parts), " ".join(words)


def _more_speech(words: int) -> np.ndarray:
    """A pause, then ``words`` new words (ids restart at w0)."""
    pause = np.random.default_rng(3).integers(-30, 31, int(PAUSE_S * RATE)).astype(np.int16)
    return np.concatenate([pause, _speech([words])[0]])


class _WordSession:
    """Deterministic fake engine: recognizes complete bursts as words.

    A burst cut by the start of the audio is unrecognizable and dropped, like a
    fragment the model cannot hear; one cut by the end is still recognized.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[int, TranscribeOptions | None, str | None]] = []
        self.block: threading.Event | None = None
        self.started = threading.Event()
        self.fail_with: BaseException | None = None

    def transcribe(self, audio, *, hotwords=None, options=None) -> TranscribeResult:
        self.calls.append((len(audio), options, hotwords))
        self.started.set()
        if self.block is not None:
            self.block.wait(5)
        if self.fail_with is not None:
            raise self.fail_with
        return _recognize(audio, options)

    def close(self) -> None:
        return


def _recognize(audio: np.ndarray, options: TranscribeOptions | None) -> TranscribeResult:
    frame = RATE // 100
    count = len(audio) // frame
    rms = np.sqrt(np.mean(np.square(audio[: count * frame].reshape(count, frame)), axis=1))
    active = np.append(rms > ACTIVE_RMS, False)
    segments: list[TranscribeSegment] = []
    start = None
    for index, is_active in enumerate(active):
        if is_active and start is None:
            start = index
        elif not is_active and start is not None:
            begin, end = start * frame, index * frame
            if begin > 0 or end - begin >= int(WORD_S * RATE) - frame:
                amplitude = float(np.median(np.abs(audio[begin:end]))) * 32768.0
                word = f"w{round((amplitude - BASE_AMP) / AMP_STEP)}"
                segments.append(TranscribeSegment(word, begin / RATE, end / RATE))
            start = None
    if not segments:
        return TranscribeResult(text="", confidence=0.0, last_speech_end=None)
    timed = options is not None and options.mode == "long_chunk" and options.without_timestamps is False
    return TranscribeResult(
        text=" ".join(segment.text for segment in segments),
        confidence=0.9,
        last_speech_end=min(len(audio) / RATE, segments[-1].end + VAD_PAD_S),
        segments=tuple(segments) if timed else (),
    )


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch):
    session = _WordSession()
    runtime = SimpleNamespace(
        open_session=lambda _id: SimpleNamespace(session=session, close=lambda: None),
    )
    monkeypatch.setattr(processor_module, "get_model_runtime", lambda: runtime)

    def configure(**overrides: object) -> None:
        monkeypatch.setattr(processor_module, "get_settings", lambda: _settings(**overrides))

    configure()
    session.configure = configure
    return session


def _context(hotwords: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        session_id="incremental",
        audio_buffer=AudioBuffer(),
        hotwords=hotwords,
        last_partial_text="",
        audio_start_time=1000.0,
        last_speech_time=None,
    )


async def _record(processor, context, audio: np.ndarray, *, step_s: float = 0.5) -> list:
    """Stream audio in steps, running one background job per step like the loop."""
    results = []
    step = int(step_s * RATE)
    for sequence, offset in enumerate(range(0, len(audio), step)):
        context.audio_buffer.append(sequence, audio[offset: offset + step])
        result = await processor.transcribe_partial()
        if result is not None:
            results.append(result)
            if result.last_speech_end is not None:
                context.last_speech_time = context.audio_start_time + result.last_speech_end
    return results


async def test_final_decodes_only_the_uncommitted_tail(engine) -> None:
    audio, expected = _speech([5, 6, 4, 7, 5, 6, 5, 4, 6, 5, 7, 4])  # ~40 s
    more = _more_speech(3)
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        await _record(processor, context, audio)
        committed_end = processor._committed.end_sample
        assert committed_end > 15 * RATE  # Sealed while recording.
        # Speech continues up to stop, after the last background job.
        context.audio_buffer.append(999, more)
        before = len(engine.calls)

        result = await processor.transcribe_final()

        final_calls = engine.calls[before:]
        assert len(final_calls) == 1
        assert final_calls[0][0] == len(audio) + len(more) - committed_end
        assert result.text == f"{expected} w0 w1 w2"
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_forced_seals_without_pauses_stitch_overlap_exactly(engine) -> None:
    # One unbroken phrase: no sealable pause, so seals are forced with overlap.
    audio, expected = _speech([140])  # ~59 s
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        await _record(processor, context, audio)
        assert processor._committed.end_sample >= 25 * RATE
        assert processor._committed.overlap_samples == int(0.75 * RATE)

        result = await processor.transcribe_final()

        assert result.text == expected  # No duplicated or dropped words.
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_silent_tail_reuses_last_decode_without_new_inference(engine) -> None:
    audio, expected = _speech([4, 5], trailing_s=1.0)
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        partials = await _record(processor, context, audio, step_s=0.25)
        assert partials[-1].text == expected
        before = len(engine.calls)

        result = await processor.transcribe_final()

        assert engine.calls[before:] == []
        assert result.text == expected
        assert result.is_empty is False
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_speech_after_last_decode_is_decoded_on_stop(engine) -> None:
    audio, expected = _speech([4, 5], trailing_s=1.0)
    more = _more_speech(3)
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        await _record(processor, context, audio)
        # Speech arrives with no partial after it: the cached decode is stale.
        context.audio_buffer.append(999, more)
        before = len(engine.calls)

        result = await processor.transcribe_final()

        assert len(engine.calls[before:]) == 1
        assert result.text == f"{expected} w0 w1 w2"
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_stop_during_inflight_partial_waits_for_one_bounded_job(engine) -> None:
    audio, expected = _speech([6, 6])
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        context.audio_buffer.append(0, audio)
        engine.block = threading.Event()
        partial = asyncio.create_task(processor.transcribe_partial())
        await asyncio.to_thread(engine.started.wait, 5)
        final = asyncio.create_task(processor.transcribe_final())
        await asyncio.sleep(0.05)
        assert not final.done()
        # Stop is pending: no new background job may start.
        assert await processor.transcribe_partial() is None
        calls_while_waiting = len(engine.calls)
        engine.block.set()

        await partial
        result = await final

        assert calls_while_waiting == 1
        # The in-flight partial covered all audio, so the final reused it.
        assert len(engine.calls) == 1
        assert result.text == expected
    finally:
        engine.block = None
        processor.close()
        context.audio_buffer.close()


async def test_failed_commit_is_never_committed_and_final_recovers_the_audio(engine) -> None:
    audio, expected = _speech([5, 6, 4, 7, 5, 6])
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        step = RATE // 2
        offset = 0
        # Record until a seal is ready, then fail exactly that commit decode.
        while offset < len(audio):
            context.audio_buffer.append(offset, audio[offset: offset + step])
            offset += step
            if processor._plan_seal(context.audio_buffer.sample_count) is not None:
                break
            await processor.transcribe_partial()
        assert offset < len(audio)
        engine.fail_with = VramExhaustedError(
            last_result=TranscribeResult("w0 w1", 0.9, 1.0),
        )
        processor._last_job_committed = False
        with pytest.raises(VramExhaustedError):
            await processor.transcribe_partial()
        assert processor._committed.texts == []
        engine.fail_with = None
        context.audio_buffer.append(offset, audio[offset:])
        while await processor.transcribe_partial() is not None:
            pass
        assert processor._committed.texts == []  # Commits stay off for this session.

        result = await processor.transcribe_final()

        assert result.text == expected
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_tail_failure_reports_committed_plus_recovered_text_as_incomplete(engine) -> None:
    audio, expected = _speech([5, 6, 4, 7, 5, 6, 5])
    tail = _more_speech(3)
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        await _record(processor, context, audio)
        committed = processor._committed.text
        assert committed
        context.audio_buffer.append(999, tail)
        engine.fail_with = IncompleteTranscriptionError(
            "native failure", last_result=TranscribeResult("recovered", 0.5, 0.5),
        )

        with pytest.raises(IncompleteTranscriptionError) as failure:
            await processor.transcribe_final()

        assert failure.value.last_result.text == f"{committed} recovered"
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_cancelled_commit_changes_nothing_and_lease_waits_for_native_work(monkeypatch, engine) -> None:
    audio, expected = _speech([5, 6, 4, 7, 5, 6])
    context = _context()
    closed = threading.Event()
    runtime = SimpleNamespace(
        open_session=lambda _id: SimpleNamespace(session=engine, close=closed.set),
    )
    monkeypatch.setattr(processor_module, "get_model_runtime", lambda: runtime)
    processor = processor_module.TranscriptionProcessor(context)
    try:
        context.audio_buffer.append(0, audio)
        assert processor._plan_seal(len(audio)) is not None
        engine.block = threading.Event()
        commit = asyncio.create_task(processor.transcribe_partial())
        await asyncio.to_thread(engine.started.wait, 5)
        commit.cancel()
        with pytest.raises(asyncio.CancelledError):
            await commit
        assert processor._committed.texts == []
        processor.close()
        assert not closed.is_set()  # Native work still owns the lease.
        engine.block.set()
        await asyncio.to_thread(closed.wait, 5)
        assert closed.is_set()
    finally:
        engine.block = None
        processor.close()
        context.audio_buffer.close()


async def test_long_dictation_seals_eagerly_and_finalizes_with_one_decode(engine) -> None:
    phrases = [5, 6, 4, 7, 5, 6, 5, 4] * 22  # ~5 minutes
    audio, expected = _speech(phrases, trailing_s=0.1)
    context = _context()
    progress: list[tuple[int, int]] = []

    async def on_progress(index: int, total: int) -> None:
        progress.append((index, total))

    processor = processor_module.TranscriptionProcessor(context)
    try:
        partials = await _record(processor, context, audio)
        assert all(result.text == "" for result in partials if result.audio_duration >= 30.0)
        assert len(audio) - processor._committed.end_sample < 26 * RATE
        before = len(engine.calls)

        result = await processor.transcribe_final(progress_callback=on_progress)

        assert len(engine.calls[before:]) <= 1
        assert progress == []
        assert result.text == expected
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_disabled_setting_keeps_legacy_whole_buffer_final(engine) -> None:
    engine.configure(incremental_commit=False)
    audio, expected = _speech([5, 6, 4, 7, 5, 6, 5, 4, 6, 5, 7, 4], trailing_s=1.0)
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        await _record(processor, context, audio, step_s=2.0)
        assert processor._committed.texts == []
        before = len(engine.calls)

        result = await processor.transcribe_final()

        chunk_lengths = [call[0] for call in engine.calls[before:]]
        assert len(chunk_lengths) == 2  # Legacy long final re-decodes everything.
        assert result.text == expected
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_hotwords_reach_commit_partial_and_final_decodes(engine) -> None:
    audio, _ = _speech([5, 6, 4, 7, 5, 6])
    context = _context(hotwords="Eve, Murmur")
    processor = processor_module.TranscriptionProcessor(context)
    try:
        await _record(processor, context, audio)
        context.audio_buffer.append(999, _more_speech(2))
        await processor.transcribe_final()
        assert processor._committed.texts
        assert {call[2] for call in engine.calls} == {"Eve, Murmur"}
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_partial_speech_timing_is_absolute_after_a_commit(engine) -> None:
    audio, _ = _speech([5, 6, 4, 7, 5, 6])
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        partials = await _record(processor, context, audio)
        assert processor._committed.end_sample > 0
        # The last word ends at the end of the audio, past the committed end.
        speech_end = context.last_speech_time - context.audio_start_time
        assert speech_end == pytest.approx(len(audio) / RATE, abs=0.02)
        assert all(
            later.last_speech_end >= earlier.last_speech_end
            for earlier, later in zip(partials, partials[1:])
        )
    finally:
        processor.close()
        context.audio_buffer.close()


def _buffer(samples: np.ndarray) -> AudioBuffer:
    buffer = AudioBuffer()
    buffer.append(0, samples)
    return buffer


def test_plan_seal_cuts_inside_a_pause_without_overlap() -> None:
    audio, _ = _speech([20, 20])  # pause near 8.5 s
    buffer = _buffer(audio)
    try:
        assert plan_seal(buffer, committed_end=0, total_samples=len(audio),
                         seal_after_s=10.0, chunk_s=25.0, overlap_s=0.75) is None
        chunk, overlap = plan_seal(buffer, committed_end=0, total_samples=len(audio),
                                   seal_after_s=5.0, chunk_s=25.0, overlap_s=0.75)
        pause_start = int((20 * WORD_S + 19 * WORD_GAP_S) * RATE)
        assert pause_start < chunk.end_sample < pause_start + int(PAUSE_S * RATE)
        assert overlap == 0
    finally:
        buffer.close()


def test_plan_seal_never_cuts_at_short_gaps_inside_a_phrase() -> None:
    audio, _ = _speech([60])  # ~25 s with only 0.12 s gaps
    buffer = _buffer(audio)
    try:
        assert plan_seal(buffer, committed_end=0, total_samples=len(audio),
                         seal_after_s=10.0, chunk_s=25.0, overlap_s=0.75) is None
    finally:
        buffer.close()


def test_is_settled_requires_confirmed_silence_and_no_new_energy() -> None:
    audio, _ = _speech([4], trailing_s=1.0)
    buffer = _buffer(audio)
    try:
        decode_end = len(audio) - RATE // 2
        decode = Decode(
            AudioChunk(1, 1, 0, decode_end, 0, decode_end),
            _recognize(audio[:decode_end].astype(np.float32) / 32768.0, None),
        )
        assert is_settled(buffer, decode, len(audio))
        buffer.append(1, np.full(RATE // 10, 4000, dtype=np.int16))
        assert not is_settled(buffer, decode, len(audio) + RATE // 10)
        # A decode that ended while speech was still going is never reusable.
        speaking = Decode(decode.chunk, TranscribeResult("w0", 0.9, decode_end / RATE - 0.1))
        assert not is_settled(buffer, speaking, len(audio))
    finally:
        buffer.close()


def test_committed_transcript_dedupes_overlap_with_timed_segments() -> None:
    state = CommittedTranscript()
    first = AudioChunk(1, 1, 0, 25 * RATE, 0, 25 * RATE)
    state.append(Decode(first, TranscribeResult(
        "a b", 0.9, 24.9, (TranscribeSegment("a", 23.0, 23.8), TranscribeSegment("b", 24.3, 24.9)),
    )))
    state.overlap_samples = int(0.75 * RATE)
    tail = state.tail_chunk(30 * RATE)
    assert tail.start_sample == int(24.25 * RATE)
    state.append(Decode(tail, TranscribeResult(
        "b c", 0.9, 2.0, (TranscribeSegment("b", 0.05, 0.65), TranscribeSegment("c", 0.8, 2.0)),
    )))
    assert state.text == "a b c"
