"""Regression tests that remain relevant after the runtime caller cutover."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import HTTPException

import app as server_app
from transcription.types import TranscribeResult
import transcription.processor as processor_module


class _FakeAudioBuffer:
    duration_seconds = 3.2

    def get_audio_float32(self) -> np.ndarray:
        return np.array([0.1, 0.2, 0.3], dtype=np.float32)


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
async def test_partial_updates_speech_time_on_duplicate_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even when text is unchanged, the runtime session updates speech time."""

    session = _TimedSession()
    runtime = _TimedRuntime(session)

    monkeypatch.setattr(
        processor_module,
        "get_settings",
        lambda: SimpleNamespace(min_audio_for_transcription=0.1),
    )
    monkeypatch.setattr(processor_module, "get_model_runtime", lambda: runtime)

    audio_start = 1000.0
    context = SimpleNamespace(
        session_id="test-session",
        audio_buffer=_FakeAudioBuffer(),
        hotwords=None,
        last_partial_text="",
        audio_start_time=audio_start,
        last_speech_time=None,
    )
    processor = processor_module.TranscriptionProcessor(context)

    first = await processor.transcribe_partial()
    assert first is not None
    assert first.text == "hello world"

    second = await processor.transcribe_partial()
    assert second is None
    assert context.last_speech_time == audio_start + 2.0
    processor.close()


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
