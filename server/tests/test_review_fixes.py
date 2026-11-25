"""Regression tests that remain relevant after the runtime caller cutover."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import HTTPException

import app as server_app
from audio.buffer import AudioBuffer
from transcription.types import TranscribeResult
import transcription.processor as processor_module


def _audio_buffer(seconds: float, amplitude: int) -> AudioBuffer:
    buffer = AudioBuffer()
    buffer.append(0, np.full(int(seconds * 16000), amplitude, dtype=np.int16))
    return buffer


class _TimedSession:
    """Session that returns the same text but advances last_speech_end."""

    def __init__(self) -> None:
        self._call_count = 0

    def transcribe(
        self,
        _audio: np.ndarray,
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult:
        del hotwords
        self._call_count += 1
        return TranscribeResult(
            text="hello world",
            confidence=0.95,
            last_speech_end=1.0 * self._call_count,
        )

    def close(self) -> None:
        return


class _TimedRuntime:
    def __init__(self, session: _TimedSession) -> None:
        self._session = session

    def open_session(self, _session_id: str) -> SimpleNamespace:
        return SimpleNamespace(session=self._session, close=lambda: None)


@pytest.mark.asyncio
async def test_duplicate_lab_draft_leaves_the_vad_clock_intact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The audio handler owns activity timing even when recognition changes."""

    session = _TimedSession()
    runtime = _TimedRuntime(session)

    monkeypatch.setattr(
        processor_module,
        "get_settings",
        lambda: SimpleNamespace(min_audio_for_transcription=0.1, incremental_commit=False),
    )
    monkeypatch.setattr(processor_module, "get_model_runtime", lambda: runtime)

    audio_start = 1000.0
    context = SimpleNamespace(
        session_id="test-session",
        audio_buffer=_audio_buffer(3.2, 300),
        speculative_partials=True,
        hotwords=None,
        last_partial_text="",
        audio_start_time=audio_start,
        last_speech_time=audio_start + 3.0,
    )
    processor = processor_module.TranscriptionProcessor(context)

    first = await processor.transcribe_partial()
    assert first is not None
    assert first.text == "hello world"

    # New, louder audio arrives; an unchanged buffer would be skipped.
    context.audio_buffer.append(1, np.full(8000, 16000, dtype=np.int16))
    second = await processor.transcribe_partial()
    assert second is None
    assert context.last_speech_time == audio_start + 3.0
    processor.close()
    context.audio_buffer.close()


@pytest.mark.asyncio
async def test_invalid_settings_returns_400() -> None:
    """PATCH /settings with no API-managed keys is rejected at the seam."""

    handler = next(
        route.endpoint
        for route in server_app.create_app().routes
        if getattr(route, "path", None) == "/settings" and "PATCH" in route.methods
    )

    with pytest.raises(HTTPException) as exc_info:
        await handler({"invalid_key": "value"})
    assert exc_info.value.status_code == 400
    assert "No valid settings" in exc_info.value.detail
