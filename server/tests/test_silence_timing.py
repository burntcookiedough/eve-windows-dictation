"""Controlled-clock coverage of the real silence monitor and terminal frames."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest

import audio.buffer as buffer_module
import websocket.handler as handler
from session.context import SessionContext
from session.state import SessionState
from websocket.sender import FrameSender


class _TickComplete(Exception):
    """Stop a nonterminal monitor after exactly one clock-controlled check."""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "now,audio_start,last_speech,audio_gap,expected_close",
    [
        (110.0, 110.0, None, 0.0, False),  # Ten-second microphone startup.
        (114.999, 110.0, None, 0.0, False),
        (115.0, 110.0, None, 0.0, True),
        (129.999, None, None, 0.0, False),  # Preserve no-audio grace.
        (130.0, None, None, 0.0, True),
        (112.999, 100.0, 108.0, 0.0, False),
        (113.0, 100.0, 108.0, 0.0, True),
        (112.0, 110.0, 111.0, 4.999, False),
        (112.0, 110.0, 111.0, 5.0, True),  # Independent audio reception timeout.
        (0.0, 0.0, None, 0.0, False),  # Zero is a valid monotonic timestamp.
        (5.0, 0.0, None, 0.0, True),
    ],
)
async def test_silence_monitor_clock_boundaries(
    monkeypatch, now, audio_start, last_speech, audio_gap, expected_close,
) -> None:
    """Startup delay must not consume speech silence, while other clocks retain their bounds."""
    clock = SimpleNamespace(monotonic=lambda: now)
    monkeypatch.setattr(handler, "time", clock)
    monkeypatch.setattr(buffer_module, "time", clock)
    context = SessionContext(silence_timeout=5.0, started_at=100.0)
    context.state_machine.transition_to(SessionState.STARTED)
    context.audio_start_time = audio_start
    context.last_speech_time = last_speech
    if audio_start is not None:
        context.audio_buffer.append(0, np.zeros(160, dtype=np.int16))
        context.audio_buffer._last_audio_time = now - audio_gap
        context.state_machine.transition_to(SessionState.STREAMING)

    ticks = 0

    async def next_tick(delay):
        nonlocal ticks
        assert delay == 0.5
        ticks += 1
        if ticks > 1:
            raise _TickComplete

    # Replace only this module's asyncio reference; never alter the event-loop clock.
    monkeypatch.setattr(handler, "asyncio", SimpleNamespace(
        sleep=next_tick, wait_for=asyncio.wait_for,
    ))
    socket = SimpleNamespace(send_json=AsyncMock(), close=AsyncMock())
    processor = SimpleNamespace(transcribe_final=AsyncMock(return_value=SimpleNamespace(
        text="", confidence=0.0, transcription_time=0.0, audio_duration=0.0,
    )))
    try:
        if expected_close:
            await handler._silence_monitor_loop(socket, FrameSender(socket, context.session_id), context, processor)
            assert context.state_machine.state == SessionState.CLOSED
            frames = [call.args[0] for call in socket.send_json.await_args_list]
            assert [frame["type"] for frame in frames] == ["final", "closing"]
            assert frames[-1]["reason"] == "silence_timeout"
            processor.transcribe_final.assert_awaited_once()
            socket.close.assert_awaited_once()
        else:
            with pytest.raises(_TickComplete):
                await handler._silence_monitor_loop(socket, FrameSender(socket, context.session_id), context, processor)
            assert context.state_machine.is_accepting_audio()
            processor.transcribe_final.assert_not_awaited()
            socket.send_json.assert_not_awaited()
            socket.close.assert_not_awaited()
    finally:
        context.audio_buffer.close()
