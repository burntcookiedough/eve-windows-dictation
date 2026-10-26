"""Synthetic transcript sentinels must stay out of ordinary finalization logs."""

import io
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from protocol.frames import ClosingReason
from session.context import SessionContext
from session.state import SessionState
from transcription.errors import IncompleteTranscriptionError
from transcription.types import TranscribeResult
from websocket.handler import _finalize_session, _partial_emission_loop


@pytest.mark.asyncio
@pytest.mark.parametrize("length", [1, 200])
@pytest.mark.parametrize("failure", [None, "message", "cause", "context"])
async def test_finalization_logs_metadata_without_transcript(length, failure):
    """Cover successful and recovered finals, including text beyond the old preview length."""
    sentinel = "SYNTHETIC_PRIVATE_TRANSCRIPT_" * length
    context = SessionContext()
    context.state_machine.transition_to(SessionState.STARTED)
    result = SimpleNamespace(
        text=sentinel, confidence=0.9, transcription_time=0.01, audio_duration=1.0,
    )
    processor = SimpleNamespace(transcribe_final=AsyncMock(return_value=result))
    if failure:
        error = IncompleteTranscriptionError(
            f"Synthetic inference failure: {sentinel}" if failure == "message" else "Synthetic inference failure",
            last_result=TranscribeResult(text=sentinel, confidence=0.9, last_speech_end=1.0),
        )
        if failure == "cause":
            error.__cause__ = RuntimeError(sentinel)
        elif failure == "context":
            error.__context__ = RuntimeError(sentinel)
        processor.transcribe_final.side_effect = error
    sender = SimpleNamespace(
        send_final=AsyncMock(), send_partial=AsyncMock(),
        send_error=AsyncMock(), send_closing=AsyncMock(),
    )
    # Capture formatted stream output, including exception formatting, rather than
    # inspecting only logging call arguments or the separate diagnostics report.
    stream = io.StringIO()
    sink = logging.StreamHandler(stream)
    logger = logging.getLogger("websocket.handler")
    old_level = logger.level
    logger.addHandler(sink)
    logger.setLevel(logging.INFO)
    try:
        await _finalize_session(sender, context, processor, ClosingReason.STOP_RECEIVED)
        sink.flush()
        ordinary_server_output = stream.getvalue()
        assert "SYNTHETIC_PRIVATE_TRANSCRIPT_" not in ordinary_server_output
        assert "Finalizing session" in ordinary_server_output
        assert "Session closed" in ordinary_server_output
        if failure:
            sender.send_final.assert_not_awaited()
            assert sender.send_partial.await_args.args[0] == sentinel
            sender.send_error.assert_awaited_once()
        else:
            assert sender.send_final.await_args.args[0] == sentinel
            assert f"{len(sentinel)} chars" in ordinary_server_output
        assert context.state_machine.state == SessionState.CLOSED
    finally:
        logger.removeHandler(sink)
        logger.setLevel(old_level)
        sink.close()
        context.audio_buffer.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("length", [1, 200])
async def test_partial_inference_exception_logs_omit_transcript(length):
    sentinel = "SYNTHETIC_PRIVATE_TRANSCRIPT_" * length
    context = SessionContext()
    context.state_machine.transition_to(SessionState.STARTED)

    async def fail_partial():
        context.state_machine.transition_to(SessionState.CLOSED)
        raise RuntimeError(sentinel) from ValueError(sentinel)

    stream = io.StringIO()
    sink = logging.StreamHandler(stream)
    logger = logging.getLogger("websocket.handler")
    logger.addHandler(sink)
    try:
        await _partial_emission_loop(
            SimpleNamespace(), context, SimpleNamespace(transcribe_partial=fail_partial), 0,
        )
        sink.flush()
        assert "Error in partial emission" in stream.getvalue()
        assert "SYNTHETIC_PRIVATE_TRANSCRIPT_" not in stream.getvalue()
        assert context.partial_in_flight is False
    finally:
        logger.removeHandler(sink)
        sink.close()
        context.audio_buffer.close()
