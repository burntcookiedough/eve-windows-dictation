"""Tests for adaptive long dictation final transcription."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

import transcription.processor as processor_module
from transcription.errors import VramExhaustedError
from transcription.long_dictation import plan_chunks, stitch_text
from transcription.types import TranscribeOptions, TranscribeResult


def _settings(**overrides: object) -> SimpleNamespace:
    defaults = {
        "min_audio_for_transcription": 0.1,
        "allow_overlapping_inference": False,
        "transcription_max_workers": 1,
        "long_dictation_threshold_s": 30.0,
        "long_dictation_chunk_s": 25.0,
        "long_dictation_overlap_s": 0.75,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class _FakeAudioBuffer:
    def __init__(self, audio: np.ndarray) -> None:
        self._audio = audio

    @property
    def duration_seconds(self) -> float:
        return len(self._audio) / 16000

    def get_audio_float32(self) -> np.ndarray:
        return self._audio


class _RecordingSession:
    def __init__(self) -> None:
        self.calls: list[tuple[int, TranscribeOptions | None]] = []

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        hotwords: str | None = None,
        options: TranscribeOptions | None = None,
    ) -> TranscribeResult:
        self.calls.append((len(audio), options))
        return TranscribeResult(
            text=f"chunk {len(self.calls)}",
            confidence=0.8,
            last_speech_end=len(audio) / 16000,
        )

    def close(self) -> None:
        return


class _RecordingManager:
    def __init__(self, session: _RecordingSession) -> None:
        self._session = session

    def create_session(self, _session_id: str) -> _RecordingSession:
        return self._session

    def release_session(self, _session_id: str) -> None:
        return


class _LowConfidenceFirstSession(_RecordingSession):
    def transcribe(
        self,
        audio: np.ndarray,
        *,
        hotwords: str | None = None,
        options: TranscribeOptions | None = None,
    ) -> TranscribeResult:
        self.calls.append((len(audio), options))
        if len(self.calls) == 1:
            return TranscribeResult(text="uncertain words", confidence=0.2, last_speech_end=1.0)
        return TranscribeResult(text="better words", confidence=0.7, last_speech_end=1.0)


class _RetryOomSession(_RecordingSession):
    def transcribe(
        self,
        audio: np.ndarray,
        *,
        hotwords: str | None = None,
        options: TranscribeOptions | None = None,
    ) -> TranscribeResult:
        self.calls.append((len(audio), options))
        if len(self.calls) == 1:
            return TranscribeResult(text="uncertain words", confidence=0.2, last_speech_end=1.0)
        if len(self.calls) == 2:
            raise VramExhaustedError(last_result=None)
        return TranscribeResult(text="recovered words", confidence=0.8, last_speech_end=1.0)


def test_plan_chunks_uses_overlap_after_first_chunk() -> None:
    audio = np.zeros(int(62.8 * 16000), dtype=np.float32)

    chunks = plan_chunks(audio, chunk_s=25.0, overlap_s=0.75)

    assert len(chunks) == 3
    assert chunks[0].start_s == pytest.approx(0.0)
    assert chunks[1].start_s == pytest.approx(chunks[0].end_s - 0.75)
    assert chunks[2].start_s == pytest.approx(chunks[1].end_s - 0.75)
    assert chunks[-1].end_s == pytest.approx(62.8)


def test_stitch_text_removes_word_overlap() -> None:
    result = stitch_text(
        [
            "This is the first part of a sentence",
            "part of a sentence that continues cleanly",
            "continues cleanly into the end.",
        ]
    )

    assert result == "This is the first part of a sentence that continues cleanly into the end."


@pytest.mark.asyncio
async def test_final_uses_single_pass_below_threshold(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _RecordingSession()
    manager = _RecordingManager(session)
    audio = np.zeros(int(10 * 16000), dtype=np.float32)
    context = SimpleNamespace(
        session_id="short",
        audio_buffer=_FakeAudioBuffer(audio),
        hotwords=None,
    )

    monkeypatch.setattr(processor_module, "get_settings", lambda: _settings())
    monkeypatch.setattr(processor_module, "get_engine_manager", lambda: manager)

    processor = processor_module.TranscriptionProcessor(context)
    result = await processor.transcribe_final()

    assert result.text == "chunk 1"
    assert len(session.calls) == 1
    assert session.calls[0][0] == len(audio)
    assert session.calls[0][1] is None


@pytest.mark.asyncio
async def test_long_partial_uses_tail_window_for_speech_timing_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _RecordingSession()
    manager = _RecordingManager(session)
    audio = np.zeros(int(40 * 16000), dtype=np.float32)
    context = SimpleNamespace(
        session_id="long-partial",
        audio_buffer=_FakeAudioBuffer(audio),
        hotwords=None,
        last_partial_text="previous visible text",
    )

    monkeypatch.setattr(processor_module, "get_settings", lambda: _settings())
    monkeypatch.setattr(processor_module, "get_engine_manager", lambda: manager)

    processor = processor_module.TranscriptionProcessor(context)
    result = await processor.transcribe_partial()

    assert result is not None
    assert result.text == ""
    assert result.is_empty is True
    assert len(session.calls) == 1
    assert session.calls[0][0] == int(25 * 16000)
    assert session.calls[0][1] is not None
    assert session.calls[0][1].condition_on_previous_text is False
    assert result.last_speech_end == pytest.approx(40.0)


@pytest.mark.asyncio
async def test_final_uses_chunked_long_path_and_reports_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _RecordingSession()
    manager = _RecordingManager(session)
    audio = np.zeros(int(62.8 * 16000), dtype=np.float32)
    context = SimpleNamespace(
        session_id="long",
        audio_buffer=_FakeAudioBuffer(audio),
        hotwords=None,
    )
    progress: list[tuple[int, int]] = []

    async def _progress(index: int, total: int) -> None:
        progress.append((index, total))

    monkeypatch.setattr(processor_module, "get_settings", lambda: _settings())
    monkeypatch.setattr(processor_module, "get_engine_manager", lambda: manager)

    processor = processor_module.TranscriptionProcessor(context)
    result = await processor.transcribe_final(progress_callback=_progress)

    assert result.text == "chunk 1 chunk 2 chunk 3"
    assert len(session.calls) == 3
    assert progress == [(1, 3), (2, 3), (3, 3)]
    assert all(call[1] is not None for call in session.calls)
    assert all(call[1].condition_on_previous_text is False for call in session.calls if call[1])


@pytest.mark.asyncio
async def test_low_confidence_long_chunk_retries_with_safer_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _LowConfidenceFirstSession()
    manager = _RecordingManager(session)
    audio = np.zeros(int(31 * 16000), dtype=np.float32)
    context = SimpleNamespace(
        session_id="retry",
        audio_buffer=_FakeAudioBuffer(audio),
        hotwords=None,
    )

    monkeypatch.setattr(
        processor_module,
        "get_settings",
        lambda: _settings(long_dictation_chunk_s=30.0),
    )
    monkeypatch.setattr(processor_module, "get_engine_manager", lambda: manager)

    processor = processor_module.TranscriptionProcessor(context)
    result = await processor.transcribe_final()

    assert result.text == "better words"
    assert len(session.calls) == 3
    assert session.calls[1][1] is not None
    assert session.calls[1][1].beam_size == 3


@pytest.mark.asyncio
async def test_low_confidence_retry_oom_keeps_first_chunk_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _RetryOomSession()
    manager = _RecordingManager(session)
    audio = np.zeros(int(31 * 16000), dtype=np.float32)
    context = SimpleNamespace(
        session_id="retry-oom",
        audio_buffer=_FakeAudioBuffer(audio),
        hotwords=None,
    )

    monkeypatch.setattr(
        processor_module,
        "get_settings",
        lambda: _settings(long_dictation_chunk_s=30.0),
    )
    monkeypatch.setattr(processor_module, "get_engine_manager", lambda: manager)

    processor = processor_module.TranscriptionProcessor(context)
    result = await processor.transcribe_final()

    assert result.text == "uncertain words recovered words"
    assert len(session.calls) == 3
