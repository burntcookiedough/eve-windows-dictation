"""Tests for protocol frame models."""

import pytest
from pydantic import ValidationError

from protocol.errors import ErrorCode
from protocol.frames import (
    ClosingFrame,
    ClosingReason,
    ErrorFrame,
    FinalTextFrame,
    PartialTextFrame,
    ReadyFrame,
    StartFrame,
    StopFrame,
    WarningCode,
    WarningFrame,
)


class TestStartFrame:
    """Tests for StartFrame."""

    def test_valid_start_frame(self) -> None:
        """Create a valid start frame."""
        frame = StartFrame(silence_timeout=5.0)

        assert frame.frame == "control"
        assert frame.type == "start"
        assert frame.silence_timeout == 5.0

    def test_start_frame_from_dict(self) -> None:
        """Parse start frame from dict."""
        data = {
            "frame": "control",
            "type": "start",
            "silence_timeout": 10.0,
            "hotwords": "Kubernetes, Svelte",
        }
        frame = StartFrame.model_validate(data)

        assert frame.silence_timeout == 10.0
        assert frame.hotwords == "Kubernetes, Svelte"

    def test_start_frame_with_hotwords(self) -> None:
        """Start frame accepts optional hotwords."""
        frame = StartFrame(silence_timeout=5.0, hotwords="Svelte, IPC, Claude")

        assert frame.hotwords == "Svelte, IPC, Claude"

    def test_start_frame_missing_timeout(self) -> None:
        """Start frame requires silence_timeout."""
        data = {"frame": "control", "type": "start"}

        with pytest.raises(ValidationError):
            StartFrame.model_validate(data)

    def test_start_frame_invalid_timeout(self) -> None:
        """Start frame rejects non-positive timeout."""
        with pytest.raises(ValidationError):
            StartFrame(silence_timeout=0)

        with pytest.raises(ValidationError):
            StartFrame(silence_timeout=-1.0)

    def test_start_frame_serialization(self) -> None:
        """Start frame serializes correctly."""
        frame = StartFrame(silence_timeout=5.0)
        data = frame.model_dump()

        assert data == {
            "frame": "control",
            "type": "start",
            "silence_timeout": 5.0,
            "partial_emission_interval": None,
            "hotwords": None,
        }


class TestStopFrame:
    """Tests for StopFrame."""

    def test_valid_stop_frame(self) -> None:
        """Create a valid stop frame."""
        frame = StopFrame()

        assert frame.frame == "control"
        assert frame.type == "stop"

    def test_stop_frame_serialization(self) -> None:
        """Stop frame serializes correctly."""
        frame = StopFrame()
        data = frame.model_dump()

        assert data == {"frame": "control", "type": "stop"}


class TestReadyFrame:
    """Tests for ReadyFrame."""

    def test_valid_ready_frame(self) -> None:
        """Create a valid ready frame."""
        frame = ReadyFrame()

        assert frame.frame == "control"
        assert frame.type == "ready"


class TestErrorFrame:
    """Tests for ErrorFrame."""

    def test_valid_error_frame(self) -> None:
        """Create a valid error frame."""
        frame = ErrorFrame(code=ErrorCode.NO_START, message="Audio before start")

        assert frame.frame == "control"
        assert frame.type == "error"
        assert frame.code == ErrorCode.NO_START
        assert frame.message == "Audio before start"

    def test_error_frame_serialization(self) -> None:
        """Error frame serializes correctly."""
        frame = ErrorFrame(code=ErrorCode.INVALID_AUDIO, message="Bad frame")
        data = frame.model_dump()

        assert data == {
            "frame": "control",
            "type": "error",
            "code": "invalid_audio",
            "message": "Bad frame",
        }


class TestClosingFrame:
    """Tests for ClosingFrame."""

    def test_valid_closing_frame(self) -> None:
        """Create a valid closing frame."""
        frame = ClosingFrame(reason=ClosingReason.STOP_RECEIVED)

        assert frame.frame == "control"
        assert frame.type == "closing"
        assert frame.reason == ClosingReason.STOP_RECEIVED

    def test_closing_frame_serialization(self) -> None:
        """Closing frame serializes correctly."""
        frame = ClosingFrame(reason=ClosingReason.SILENCE_TIMEOUT)
        data = frame.model_dump()

        assert data == {
            "frame": "control",
            "type": "closing",
            "reason": "silence_timeout",
        }


class TestWarningFrame:
    """Tests for WarningFrame."""

    def test_valid_warning_frame(self) -> None:
        """Create a valid warning frame."""
        frame = WarningFrame(
            code=WarningCode.VRAM_EXHAUSTED,
            message="GPU VRAM exhausted",
        )

        assert frame.frame == "control"
        assert frame.type == "warning"
        assert frame.code == WarningCode.VRAM_EXHAUSTED
        assert frame.message == "GPU VRAM exhausted"

    def test_warning_frame_serialization(self) -> None:
        """Warning frame serializes correctly."""
        frame = WarningFrame(
            code=WarningCode.VRAM_EXHAUSTED,
            message="GPU VRAM exhausted",
        )
        data = frame.model_dump()

        assert data == {
            "frame": "control",
            "type": "warning",
            "code": "vram_exhausted",
            "message": "GPU VRAM exhausted",
        }


class TestPartialTextFrame:
    """Tests for PartialTextFrame."""

    def test_valid_partial_frame(self) -> None:
        """Create a valid partial text frame."""
        frame = PartialTextFrame(
            text="hello world",
            confidence=0.85,
            transcription_time=0.1,
            audio_duration=1.0,
        )

        assert frame.frame == "text"
        assert frame.type == "partial"
        assert frame.text == "hello world"
        assert frame.confidence == 0.85

    def test_partial_frame_empty_text(self) -> None:
        """Partial frame can have empty text."""
        frame = PartialTextFrame(
            text="",
            confidence=0.0,
            transcription_time=0.1,
            audio_duration=1.0,
        )

        assert frame.text == ""

    def test_partial_frame_confidence_bounds(self) -> None:
        """Partial frame confidence must be 0-1."""
        PartialTextFrame(
            text="test", confidence=0.0, transcription_time=0.1, audio_duration=1.0
        )
        PartialTextFrame(
            text="test", confidence=1.0, transcription_time=0.1, audio_duration=1.0
        )

        with pytest.raises(ValidationError):
            PartialTextFrame(
                text="test",
                confidence=-0.1,
                transcription_time=0.1,
                audio_duration=1.0,
            )

        with pytest.raises(ValidationError):
            PartialTextFrame(
                text="test",
                confidence=1.1,
                transcription_time=0.1,
                audio_duration=1.0,
            )


class TestFinalTextFrame:
    """Tests for FinalTextFrame."""

    def test_valid_final_frame(self) -> None:
        """Create a valid final text frame."""
        frame = FinalTextFrame(
            text="hello world",
            confidence=0.95,
            transcription_time=0.1,
            audio_duration=1.0,
        )

        assert frame.frame == "text"
        assert frame.type == "final"
        assert frame.text == "hello world"
        assert frame.confidence == 0.95

    def test_final_frame_can_have_empty_text(self) -> None:
        """Final frame allows empty text when no speech was recognized."""
        frame = FinalTextFrame(
            text="",
            confidence=0.0,
            transcription_time=0.1,
            audio_duration=1.0,
        )

        assert frame.text == ""

    def test_final_frame_confidence_bounds(self) -> None:
        """Final frame confidence must be 0-1."""
        FinalTextFrame(
            text="test", confidence=0.0, transcription_time=0.1, audio_duration=1.0
        )
        FinalTextFrame(
            text="test", confidence=1.0, transcription_time=0.1, audio_duration=1.0
        )

        with pytest.raises(ValidationError):
            FinalTextFrame(
                text="test",
                confidence=-0.1,
                transcription_time=0.1,
                audio_duration=1.0,
            )

        with pytest.raises(ValidationError):
            FinalTextFrame(
                text="test",
                confidence=1.1,
                transcription_time=0.1,
                audio_duration=1.0,
            )
