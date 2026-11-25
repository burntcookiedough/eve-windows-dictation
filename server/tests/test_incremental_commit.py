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


EDGE_QUIET_S = 0.1  # Recordings start and end with a little room tone.
MIN_SPEECH_S = 0.2  # Like Silero VAD: shorter bursts (clicks) are not speech.


def _noise(seconds: float, seed: int = 7) -> np.ndarray:
    return np.random.default_rng(seed).integers(-30, 31, int(seconds * RATE)).astype(np.int16)


def _burst(amplitude: int, seconds: float = WORD_S) -> np.ndarray:
    burst = np.full(int(seconds * RATE), amplitude, dtype=np.int16)
    burst[1::2] *= -1
    return burst


def _speech(
    phrases: list[int],
    *,
    pause_s: float = PAUSE_S,
    word_gap_s: float = WORD_GAP_S,
    trailing_s: float = EDGE_QUIET_S,
) -> tuple[np.ndarray, str]:
    """Synthetic speech: each word is a square-wave burst whose amplitude is its id."""
    rng = np.random.default_rng(7)
    parts: list[np.ndarray] = []
    words: list[str] = []

    def quiet(seconds: float) -> None:
        parts.append(rng.integers(-30, 31, int(seconds * RATE)).astype(np.int16))

    quiet(EDGE_QUIET_S)
    word_id = 0
    for phrase_index, length in enumerate(phrases):
        if phrase_index:
            quiet(pause_s)
        for position in range(length):
            if position and word_gap_s:
                quiet(word_gap_s)
            parts.append(_burst(BASE_AMP + AMP_STEP * (word_id % 100)))
            words.append(f"w{word_id % 100}")
            word_id += 1
    quiet(trailing_s)
    return np.concatenate(parts), " ".join(words)


def _more_speech(words: int) -> np.ndarray:
    """A pause, then ``words`` new words (ids restart at w0)."""
    return np.concatenate([_noise(PAUSE_S, seed=3), _speech([words])[0]])


class _WordSession:
    """Deterministic fake engine: recognizes complete word bursts.

    A burst cut by either edge of the decoded audio is a fragment the model
    cannot hear and is dropped, so a seal that cuts a word loses it unless the
    next decode re-hears it through overlap. Bursts under ``MIN_SPEECH_S`` are
    not speech, like VAD.
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
    levels = np.median(np.abs(audio[: count * frame].reshape(count, frame)), axis=1) * 32768.0
    # Word id per 10 ms frame; adjacent words differ in amplitude.
    ids = [round((level - BASE_AMP) / AMP_STEP) if level > 500 else None for level in levels]
    segments: list[TranscribeSegment] = []
    start = 0
    for index in range(1, count + 1):
        if index < count and ids[index] == ids[start]:
            continue
        begin, end = start * frame, index * frame
        is_word = ids[start] is not None and end - begin >= MIN_SPEECH_S * RATE
        if is_word and begin > 0 and index < count:
            segments.append(TranscribeSegment(f"w{ids[start]}", begin / RATE, end / RATE))
        start = index
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
    # Contiguous words with no gaps: no sealable pause, so every seal is forced
    # and lands inside a word. Only overlap lets the next decode re-hear it.
    audio, expected = _speech([200], word_gap_s=0.0)  # ~60 s
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    overlap = int(0.75 * RATE)
    try:
        await _record(processor, context, audio)

        result = await processor.transcribe_final()

        assert result.text == expected  # No duplicated or dropped words.
        assert processor._committed.end_sample >= 45 * RATE  # Two forced seals.
        assert processor._committed.overlap_samples == overlap
        # The second commit re-heard the first forced boundary.
        second = processor._committed.previous.chunk
        assert second.logical_start_sample - second.start_sample == overlap
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


async def test_empty_first_decode_is_never_reused_once_speech_arrives(engine) -> None:
    # A first partial that heard only a click returns no segments. Soft speech
    # at under twice the click's level must still be decoded, not skipped.
    start = np.concatenate([_noise(0.1), _burst(1500, 0.04), _noise(0.36, seed=5)])
    words, expected = _speech([5])  # amplitudes 2000..3000
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        context.audio_buffer.append(0, start)
        assert await processor.transcribe_partial() is None  # empty decode, cached
        assert processor._tail is not None and processor._tail.result.last_speech_end is None
        await _record(processor, context, words)

        result = await processor.transcribe_final()

        assert result.text == expected
    finally:
        processor.close()
        context.audio_buffer.close()


class _ScriptedSession:
    """Returns prepared results in order; models a decoder that hears whispers."""

    def __init__(self, results: list[TranscribeResult | BaseException]) -> None:
        self.results = results
        self.calls = 0

    def transcribe(self, audio, *, hotwords=None, options=None) -> TranscribeResult:
        result = self.results[min(self.calls, len(self.results) - 1)]
        self.calls += 1
        if isinstance(result, BaseException):
            raise result
        return result

    def close(self) -> None:
        return


def _scripted(
    monkeypatch: pytest.MonkeyPatch, results: list[TranscribeResult | BaseException],
) -> _ScriptedSession:
    session = _ScriptedSession(results)
    runtime = SimpleNamespace(
        open_session=lambda _id: SimpleNamespace(session=session, close=lambda: None),
    )
    monkeypatch.setattr(processor_module, "get_model_runtime", lambda: runtime)
    monkeypatch.setattr(processor_module, "get_settings", lambda: _settings())
    return session


async def test_stop_after_an_empty_decode_always_decodes_the_tail(monkeypatch) -> None:
    # Speech at 1.5x the room noise passes the energy check, but the model may
    # still hear it. A decode that heard nothing must never stand in for it.
    session = _scripted(monkeypatch, [
        TranscribeResult("", 0.0, None),
        TranscribeResult("quiet words", 0.6, 2.4),
    ])
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        context.audio_buffer.append(0, _noise(0.5))
        assert await processor.transcribe_partial() is None
        assert session.calls == 1
        context.audio_buffer.append(1, _burst(26, 2.0))  # ~1.5x noise RMS
        assert await processor.transcribe_partial() is None  # skipped as settled

        result = await processor.transcribe_final()

        assert session.calls == 2
        assert result.text == "quiet words"
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_whispered_continuation_beyond_reuse_cap_is_redecoded(monkeypatch) -> None:
    session = _scripted(monkeypatch, [
        TranscribeResult("loud words", 0.9, 0.5),
        TranscribeResult("loud words quiet words", 0.8, 4.5),
    ])
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        context.audio_buffer.append(0, np.concatenate([_noise(0.1), _burst(4000), _noise(0.5, seed=4)]))
        partial = await processor.transcribe_partial()
        assert partial.text == "loud words"
        context.audio_buffer.append(1, _burst(21, 4.0))  # ~1.2x noise, 4 s

        result = await processor.transcribe_final()

        assert session.calls == 2
        assert result.text == "loud words quiet words"
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_partial_speech_timing_never_moves_backwards(monkeypatch) -> None:
    # Later windows can hear less (say only their overlap); timing must hold.
    _scripted(monkeypatch, [
        TranscribeResult("a b", 0.9, 3.0),
        TranscribeResult("a b", 0.9, 1.0),  # unchanged text branch
        TranscribeResult("a b c", 0.9, 2.0),  # emitted branch
    ])
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)

    async def step(sequence: int, seconds: float):
        # Each step is louder than the last, so none is skipped as settled.
        context.audio_buffer.append(sequence, _burst(3000 * 3 ** sequence, seconds))
        return await processor.transcribe_partial()

    try:
        first = await step(0, 3.5)  # long enough for its 3.0 s speech end
        assert first.text == "a b" and first.last_speech_end == 3.0
        context.last_speech_time = context.audio_start_time + first.last_speech_end

        assert await step(1, 1.0) is None  # unchanged text writes timing directly
        assert context.last_speech_time == context.audio_start_time + 3.0

        third = await step(2, 1.0)
        assert third.text == "a b c"
        assert third.last_speech_end == 3.0
    finally:
        processor.close()
        context.audio_buffer.close()


@pytest.mark.parametrize("overlap_speech_end_s", [0.5, 0.75])  # inside, and exactly at the end
async def test_reuse_requires_speech_after_the_committed_end(monkeypatch, overlap_speech_end_s) -> None:
    # After a forced seal, a tail decode whose only speech was in the overlap
    # (ending at the committed end at the latest) heard nothing uncommitted;
    # quiet speech after it must still be decoded.
    session = _scripted(monkeypatch, [TranscribeResult("quiet words", 0.6, 1.4)])
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    end, overlap = 5 * RATE, int(0.75 * RATE)
    try:
        context.audio_buffer.append(0, _noise(6.6))
        processor._committed = CommittedTranscript(
            end_sample=end, overlap_samples=overlap, texts=["committed words"],
        )
        decoded_to = 6 * RATE
        processor._tail = Decode(
            AudioChunk(1, 1, end - overlap, decoded_to, end, decoded_to),
            TranscribeResult("", 0.0, overlap_speech_end_s),
        )
        assert is_settled(context.audio_buffer, processor._tail, context.audio_buffer.sample_count)

        result = await processor.transcribe_final()

        assert session.calls == 1
        assert result.text == "committed words quiet words"
    finally:
        processor.close()
        context.audio_buffer.close()


async def test_commit_retry_out_of_vram_is_a_failed_commit(monkeypatch) -> None:
    audio, _ = _speech([5, 6, 4, 7, 5, 6])
    session = _scripted(monkeypatch, [
        TranscribeResult("w0 maybe", 0.2, 3.0),  # suspicious first pass
        VramExhaustedError(last_result=None),  # its retry runs out of VRAM
        TranscribeResult("final words", 0.9, 16.0),
    ])
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        context.audio_buffer.append(0, audio)
        assert processor._plan_seal(len(audio)) is not None
        with pytest.raises(VramExhaustedError):
            await processor.transcribe_partial()
        assert processor._committed.texts == []
        assert processor._committed.end_sample == 0
        assert processor._incremental is False  # commits off for this session

        result = await processor.transcribe_final()

        assert session.calls == 3
        assert result.text == "final words"
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


async def test_commit_advances_speech_timing_but_never_rewinds_it(engine) -> None:
    audio, _ = _speech([5, 6, 4, 7, 5, 6])
    context = _context()
    processor = processor_module.TranscriptionProcessor(context)
    try:
        # A backlog: the first job is a commit, before any partial reported.
        context.audio_buffer.append(0, audio)
        committed = await processor.transcribe_partial()
        assert processor._committed.texts
        assert committed is not None and committed.is_empty
        assert committed.last_speech_end == processor._committed.last_speech_end
        partial = await processor.transcribe_partial()
        assert partial.last_speech_end > committed.last_speech_end
        # A later commit whose speech ends before the reported time stays silent.
        assert processor._commit_speech_timing(len(audio), 0.0) is None
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


def _settled_case(reference: np.ndarray, new_audio: np.ndarray) -> bool:
    """A decode that heard one word, then ``reference`` (non-speech), then ``new_audio``."""
    word = np.concatenate([_noise(0.1), _burst(4000)])
    heard = np.concatenate([word, reference])
    buffer = _buffer(np.concatenate([heard, new_audio]))
    try:
        speech_end = len(word) / RATE
        decode = Decode(
            AudioChunk(1, 1, 0, len(heard), 0, len(heard)),
            TranscribeResult("w8", 0.9, speech_end),
        )
        return is_settled(buffer, decode, len(heard) + len(new_audio))
    finally:
        buffer.close()


def test_is_settled_rejects_transients_soft_speech_and_long_gaps() -> None:
    quiet = _noise(0.6, seed=11)
    assert _settled_case(quiet, _noise(2.0, seed=12))
    # A click inside the reference stretch must not raise the limit.
    with_click = np.concatenate([quiet[:4800], _burst(1500, 0.04), quiet[4800:]])
    assert not _settled_case(with_click, _noise(1.0, seed=12))
    assert not _settled_case(quiet, np.concatenate([_noise(0.5, seed=12), _burst(150)]))
    # A no-segment decode needs a steady window too, and a bounded gap.
    assert not _settled_case(quiet, _noise(11.0, seed=12))


def test_is_settled_hears_a_trailing_partial_frame() -> None:
    # 20 ms of silence then 19 ms of loud audio: the loud part is a leftover
    # partial frame and must still count.
    quiet = _noise(0.6, seed=11)
    assert not _settled_case(quiet, np.concatenate([_noise(0.02, seed=12), _burst(8000, 0.019)]))


def test_forced_seal_overlap_never_reaches_before_its_own_decode() -> None:
    audio, _ = _speech([40], word_gap_s=0.0)  # no pauses: the seal is forced
    buffer = _buffer(audio)
    try:
        committed_end = RATE
        chunk, overlap = plan_seal(
            buffer, committed_end=committed_end, total_samples=len(audio),
            seal_after_s=0.5, chunk_s=2.0, overlap_s=5.0,
        )
        assert chunk.start_sample == committed_end
        assert 0 < overlap == chunk.end_sample - chunk.start_sample
    finally:
        buffer.close()


def test_plan_chunks_overlap_never_reaches_before_the_planned_range() -> None:
    from transcription.long_dictation import plan_chunks

    audio = np.zeros(30 * RATE, dtype=np.float32)
    chunks = plan_chunks(audio, chunk_s=2.0, overlap_s=5.0, start_sample=20 * RATE)
    assert len(chunks) > 1
    assert min(chunk.start_sample for chunk in chunks) == 20 * RATE
    assert chunks[1].start_sample == 20 * RATE < chunks[1].logical_start_sample


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
