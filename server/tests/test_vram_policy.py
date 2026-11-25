"""Tests for VRAM-aware engine policy and OOM fallback behavior."""

from types import SimpleNamespace

import numpy as np
import pytest

from audio.buffer import AudioBuffer
from transcription.errors import VramExhaustedError
from transcription.types import TranscribeResult
import transcription.processor as processor_module


def _audio_buffer() -> AudioBuffer:
    buffer = AudioBuffer()
    buffer.append(0, np.full(int(3.2 * 16000), 3000, dtype=np.int16))
    return buffer


class _FakeSession:
    def __init__(self) -> None:
        self._last = TranscribeResult(text="last good", confidence=0.93, last_speech_end=2.8)

    def transcribe(
        self,
        _audio: np.ndarray,
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult:
        raise VramExhaustedError(last_result=self._last)

    def finalize(self) -> TranscribeResult:
        return self._last

    def close(self) -> None:
        return


class _FakeRuntime:
    def __init__(self, session: _FakeSession) -> None:
        self._session = session

    def open_session(self, _session_id: str) -> SimpleNamespace:
        return SimpleNamespace(session=self._session, close=lambda: None)


@pytest.mark.asyncio
async def test_transcribe_final_preserves_incomplete_result_after_vram_oom(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_session = _FakeSession()
    fake_runtime = _FakeRuntime(fake_session)

    monkeypatch.setattr(processor_module, "get_settings", lambda: SimpleNamespace(min_audio_for_transcription=0.1))
    monkeypatch.setattr(processor_module, "get_model_runtime", lambda: fake_runtime)

    context = SimpleNamespace(
        session_id="test-session",
        audio_buffer=_audio_buffer(),
        hotwords=None,
        last_partial_text="",
    )
    processor = processor_module.TranscriptionProcessor(context)

    try:
        with pytest.raises(VramExhaustedError) as failure:
            await processor.transcribe_final()
        result = failure.value.last_result
        assert result.text == "last good"
        assert result.confidence == pytest.approx(0.93)
        assert result.last_speech_end == pytest.approx(2.8)
    finally:
        processor.close()
