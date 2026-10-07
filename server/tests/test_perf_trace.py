"""Unit and regression tests for opt-in monotonic perf tracing, boundaries, and privacy."""

from __future__ import annotations

import asyncio
import collections
import logging
import os
import unittest.mock as mock
import pytest
from pydantic import ValidationError

from perf_trace import (
    ServerPerfTiming,
    clear_server_traces,
    get_recent_server_traces,
    is_perf_trace_enabled,
    record_server_perf,
    sanitize_correlation_id,
    validate_correlation_id,
)
from protocol.frames import FinalTextFrame
from websocket.sender import FrameSender


def test_perf_trace_opt_out_preserves_wire_payload(monkeypatch):
    """When MURMUR_PERF_TRACE is not set, final frame wire JSON has no perf field."""
    monkeypatch.delenv("MURMUR_PERF_TRACE", raising=False)
    assert not is_perf_trace_enabled()

    frame = FinalTextFrame(
        text="hello test",
        confidence=0.95,
        transcription_time=0.123,
        audio_duration=2.5,
    )
    dumped = frame.model_dump()
    assert dumped.get("perf") is None

    # FrameSender strips None perf from wire payload
    mock_ws = mock.AsyncMock()
    sender = FrameSender(mock_ws, session_id="test-session-001")
    asyncio.run(
        sender.send_final(
            text="hello test",
            confidence=0.95,
            transcription_time=0.123,
            audio_duration=2.5,
        )
    )

    sent_json = mock_ws.send_json.call_args[0][0]
    assert "perf" not in sent_json
    assert sent_json["frame"] == "text"
    assert sent_json["type"] == "final"
    assert sent_json["text"] == "hello test"
    assert sent_json["confidence"] == 0.95


def test_perf_trace_opt_in_includes_perf_on_wire(monkeypatch):
    """When MURMUR_PERF_TRACE=1, final frame wire JSON includes validated perf object."""
    monkeypatch.setenv("MURMUR_PERF_TRACE", "1")
    assert is_perf_trace_enabled()

    perf = ServerPerfTiming(
        session_id="session-trace-123",
        lock_wait_ms=1.2,
        executor_queue_wait_ms=0.5,
        model_inference_ms=150.3,
    )
    frame = FinalTextFrame(
        text="hello test",
        confidence=0.95,
        transcription_time=0.152,
        audio_duration=2.5,
        perf=perf,
    )
    dumped = frame.model_dump()
    assert dumped["perf"] is not None
    assert dumped["perf"]["session_id"] == "session-trace-123"
    assert dumped["perf"]["clock_domain"] == "python_perf_counter"
    assert dumped["perf"]["lock_wait_ms"] == 1.2
    assert dumped["perf"]["model_inference_ms"] == 150.3

    mock_ws = mock.AsyncMock()
    sender = FrameSender(mock_ws, session_id="session-trace-123")
    asyncio.run(
        sender.send_final(
            text="hello test",
            confidence=0.95,
            transcription_time=0.152,
            audio_duration=2.5,
            perf=perf,
        )
    )

    sent_json = mock_ws.send_json.call_args[0][0]
    assert "perf" in sent_json
    assert sent_json["perf"]["session_id"] == "session-trace-123"
    assert perf.ws_send_duration_ms is not None


def test_correlation_id_validation_and_sanitization():
    """Correlation IDs must be bounded (<=64 chars), alphanumeric/safe, no arbitrary paths."""
    assert validate_correlation_id("abc-123_test.01")
    assert validate_correlation_id("a" * 64)
    # Exceeding length
    assert not validate_correlation_id("a" * 65)
    # Injection / unsafe chars
    assert not validate_correlation_id("../../etc/passwd")
    assert not validate_correlation_id("C:\\Windows\\System32")
    assert not validate_correlation_id("user speech text with spaces")
    assert not validate_correlation_id("")
    assert not validate_correlation_id(None)

    # Sanitization
    valid = "session-valid-99"
    assert sanitize_correlation_id(valid) == valid
    sanitized = sanitize_correlation_id("unsafe value with spaces")
    assert validate_correlation_id(sanitized)
    assert sanitized != "unsafe value with spaces"


def test_bounded_memory_ring_buffer(monkeypatch):
    """Trace buffer strictly preserves bounded memory (maxlen=50)."""
    monkeypatch.setenv("MURMUR_PERF_TRACE", "1")
    clear_server_traces()

    for i in range(100):
        timing = ServerPerfTiming(
            session_id=f"session-{i}",
            model_inference_ms=float(i),
        )
        record_server_perf(timing)

    records = get_recent_server_traces()
    assert len(records) == 50
    # First recorded should be session-50 through session-99
    assert records[0]["session_id"] == "session-50"
    assert records[-1]["session_id"] == "session-99"

    clear_server_traces()
    assert len(get_recent_server_traces()) == 0


def test_privacy_no_transcript_snippets_in_logs(caplog):
    """Server loggers in handler/sender touched paths must never log transcript snippets."""
    caplog.set_level(logging.DEBUG)

    mock_ws = mock.AsyncMock()
    sender = FrameSender(mock_ws, session_id="test-privacy-sess")

    private_phrase = "SUPER_SECRET_PATIENT_RECORD_XYZ_12345"

    asyncio.run(
        sender.send_partial(
            text=private_phrase,
            confidence=0.88,
            transcription_time=0.05,
            audio_duration=1.0,
        )
    )

    asyncio.run(
        sender.send_final(
            text=private_phrase,
            confidence=0.99,
            transcription_time=0.15,
            audio_duration=1.0,
        )
    )

    # Check that private_phrase never appears in any log record
    for record in caplog.records:
        assert private_phrase not in record.getMessage()
        # Verify that character length is logged instead
        if "Sent final" in record.getMessage():
            assert f"({len(private_phrase)} chars" in record.getMessage()
        if "Sent partial" in record.getMessage():
            assert f"({len(private_phrase)} chars" in record.getMessage()

def test_default_partial_wire_and_disabled_final_ignore_trace(monkeypatch):
    """Diagnostics cannot add fields to ordinary partial/final messages."""
    monkeypatch.delenv('MURMUR_PERF_TRACE', raising=False)
    ws = mock.AsyncMock()
    sender = FrameSender(ws, session_id='wire-test')
    asyncio.run(sender.send_partial('fictional', .9, .1, 1.0))
    partial = ws.send_json.call_args.args[0]
    assert partial == {'frame': 'text', 'type': 'partial', 'text': 'fictional', 'confidence': .9, 'transcription_time': .1, 'audio_duration': 1.0}
    asyncio.run(sender.send_final('fictional', .9, .1, 1.0, perf=ServerPerfTiming(session_id='trace')))
    assert 'perf' not in ws.send_json.call_args.args[0]


@pytest.mark.parametrize('duration', [-1.0, float('nan'), float('inf'), True, '1.2'])
def test_trace_rejects_nonfinite_or_coerced_duration(duration):
    """Safe traces reject invalid durations instead of exporting invented values."""
    with pytest.raises(ValidationError):
        ServerPerfTiming(session_id='trace', model_inference_ms=duration)


def test_trace_rejects_unsafe_ids_and_arbitrary_content():
    """Fixed trace schema cannot carry transcript/path extras."""
    for fields in ({'session_id': 'private speech'}, {'session_id': 'trace', 'text': 'CANARY'}):
        with pytest.raises(ValidationError):
            ServerPerfTiming(**fields)

@pytest.mark.asyncio
async def test_real_processor_traces_lock_and_worker_boundaries(monkeypatch):
    """Exercise real lock/executor wrappers with controlled work; no model speed claim."""
    import time
    import numpy as np
    import transcription.processor as processor_module
    from session.context import SessionContext
    from types import SimpleNamespace
    from transcription.types import TranscribeResult

    monkeypatch.setenv('MURMUR_PERF_TRACE', '1')
    class SlowSession:
        def transcribe(self, *args, **kwargs):
            time.sleep(.02)
            return TranscribeResult(text="chunk 1", confidence=.9, last_speech_end=1.0)
        def close(self):
            pass
    session = SlowSession()
    monkeypatch.setattr(processor_module, 'get_settings', lambda: SimpleNamespace(min_audio_for_transcription=.1, allow_overlapping_inference=False))
    monkeypatch.setattr(processor_module, 'get_model_runtime', lambda: SimpleNamespace(open_session=lambda _: SimpleNamespace(session=session, close=lambda: None)))
    context = SessionContext(trace_id='correlated-trial')
    context.audio_buffer.append(0, np.zeros(16000, dtype=np.int16))
    context.stop_received_at = time.perf_counter()
    context.partial_task_active_at_stop = True
    processor = processor_module.TranscriptionProcessor(context)
    lock = processor_module.get_inference_lock()
    await lock.acquire()
    task = asyncio.create_task(processor.transcribe_final())
    try:
        await asyncio.sleep(.025)
        lock.release()
        result = await task
        assert result.text == 'chunk 1'
        assert result.perf.session_id == 'correlated-trial'
        assert result.perf.lock_wait_ms >= 15
        assert result.perf.model_inference_ms >= 15
        assert result.perf.final_inference_end_offset_ms > result.perf.final_inference_start_offset_ms
        assert result.perf.outstanding_partial_wait_ms is None
        assert result.perf.partial_task_active_at_stop is True
        assert result.perf.ws_send_duration_ms is None
    finally:
        if lock.locked(): lock.release()
        await asyncio.gather(task, return_exceptions=True)
        processor.close()
        context.audio_buffer.close()
