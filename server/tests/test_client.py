"""Unit tests for VoiceClient."""

import asyncio
import json
import struct
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from murmur_testui.client import (
    VoiceClient,
    ConnectedEvent,
    ReadyEvent,
    PartialEvent,
    FinalEvent,
    ClosingEvent,
    ErrorEvent,
)


class TestVoiceClient:
    """Tests for VoiceClient class."""

    @pytest.fixture
    def client(self) -> VoiceClient:
        return VoiceClient()

    @pytest.fixture
    def mock_ws(self):
        """Create a mock WebSocket."""
        ws = AsyncMock()
        ws.send = AsyncMock()
        ws.close = AsyncMock()
        return ws

    def test_event_callback_registration(self, client: VoiceClient):
        """Test event callback can be set and retrieved."""
        callback = MagicMock()
        client.on_event = callback
        assert client.on_event is callback

    def test_emit_calls_callback(self, client: VoiceClient):
        """Test _emit calls registered callback."""
        callback = MagicMock()
        client.on_event = callback

        event = ReadyEvent()
        client._emit(event)

        callback.assert_called_once_with(event)

    def test_emit_without_callback(self, client: VoiceClient):
        """Test _emit doesn't raise when no callback is set."""
        client._emit(ReadyEvent())  # Should not raise

    def test_handle_ready_message(self, client: VoiceClient):
        """Test handling of ready control message."""
        events = []
        client.on_event = events.append

        message = json.dumps({"frame": "control", "type": "ready"})
        client._handle_json_message(message)

        assert len(events) == 1
        assert isinstance(events[0], ReadyEvent)
        assert client._ready_event.is_set()

    def test_handle_partial_message(self, client: VoiceClient):
        """Test handling of partial text message."""
        events = []
        client.on_event = events.append

        message = json.dumps(
            {"frame": "text", "type": "partial", "text": "hello", "confidence": 0.85}
        )
        client._handle_json_message(message)

        assert len(events) == 1
        assert isinstance(events[0], PartialEvent)
        assert events[0].text == "hello"
        assert events[0].confidence == 0.85

    def test_handle_final_message(self, client: VoiceClient):
        """Test handling of final text message."""
        events = []
        client.on_event = events.append

        message = json.dumps(
            {
                "frame": "text",
                "type": "final",
                "text": "hello world",
                "confidence": 0.95,
            }
        )
        client._handle_json_message(message)

        assert len(events) == 1
        assert isinstance(events[0], FinalEvent)
        assert events[0].text == "hello world"
        assert events[0].confidence == 0.95

    def test_handle_closing_message(self, client: VoiceClient):
        """Test handling of closing control message."""
        events = []
        client.on_event = events.append

        message = json.dumps(
            {"frame": "control", "type": "closing", "reason": "stop_received"}
        )
        client._handle_json_message(message)

        assert len(events) == 1
        assert isinstance(events[0], ClosingEvent)
        assert events[0].reason == "stop_received"

    def test_handle_error_message(self, client: VoiceClient):
        """Test handling of error control message."""
        events = []
        client.on_event = events.append

        message = json.dumps(
            {
                "frame": "control",
                "type": "error",
                "code": "invalid_frame",
                "message": "Bad frame format",
            }
        )
        client._handle_json_message(message)

        assert len(events) == 1
        assert isinstance(events[0], ErrorEvent)
        assert events[0].code == "invalid_frame"
        assert events[0].message == "Bad frame format"

    def test_handle_invalid_json(self, client: VoiceClient):
        """Test handling of invalid JSON message."""
        events = []
        client.on_event = events.append

        client._handle_json_message("not json")

        assert len(events) == 0  # No event emitted

    @pytest.mark.asyncio
    async def test_start_sends_frame(self, client: VoiceClient, mock_ws):
        """Test start() sends correct start frame."""
        client._ws = mock_ws
        client._ready_event.set()  # Pre-set so we don't wait

        await client.start(silence_timeout=3.0)

        mock_ws.send.assert_called_once()
        sent_data = json.loads(mock_ws.send.call_args[0][0])
        assert sent_data == {
            "frame": "control",
            "type": "start",
            "silence_timeout": 3.0,
        }

    @pytest.mark.asyncio
    async def test_stop_sends_frame(self, client: VoiceClient, mock_ws):
        """Test stop() sends correct stop frame."""
        client._ws = mock_ws

        await client.stop()

        mock_ws.send.assert_called_once()
        sent_data = json.loads(mock_ws.send.call_args[0][0])
        assert sent_data == {"frame": "control", "type": "stop"}

    @pytest.mark.asyncio
    async def test_send_audio_format(self, client: VoiceClient, mock_ws):
        """Test send_audio() sends correctly formatted binary frame."""
        client._ws = mock_ws
        client._sequence = 42

        samples = np.array([100, -100, 200, -200], dtype=np.int16)
        await client.send_audio(samples)

        mock_ws.send.assert_called_once()
        frame = mock_ws.send.call_args[0][0]

        # Parse header
        seq, count, flags = struct.unpack(">HHB", frame[:5])
        assert seq == 42
        assert count == 4
        assert flags == 0

        # Parse samples
        audio_data = np.frombuffer(frame[5:], dtype=np.int16)
        np.testing.assert_array_equal(audio_data, samples)

    @pytest.mark.asyncio
    async def test_sequence_increment(self, client: VoiceClient, mock_ws):
        """Test sequence number increments correctly."""
        client._ws = mock_ws
        client._sequence = 0

        samples = np.array([0], dtype=np.int16)

        await client.send_audio(samples)
        assert client._sequence == 1

        await client.send_audio(samples)
        assert client._sequence == 2

    @pytest.mark.asyncio
    async def test_sequence_wraps(self, client: VoiceClient, mock_ws):
        """Test sequence number wraps at 65535."""
        client._ws = mock_ws
        client._sequence = 65535

        samples = np.array([0], dtype=np.int16)
        await client.send_audio(samples)

        assert client._sequence == 0

    @pytest.mark.asyncio
    async def test_send_audio_converts_dtype(self, client: VoiceClient, mock_ws):
        """Test send_audio() converts non-int16 arrays."""
        client._ws = mock_ws

        samples = np.array([100.5, -100.5], dtype=np.float32)
        await client.send_audio(samples)

        frame = mock_ws.send.call_args[0][0]
        audio_data = np.frombuffer(frame[5:], dtype=np.int16)
        assert audio_data.dtype == np.int16

    @pytest.mark.asyncio
    async def test_operations_fail_when_not_connected(self, client: VoiceClient):
        """Test operations raise when not connected."""
        with pytest.raises(RuntimeError, match="Not connected"):
            await client.start()

        with pytest.raises(RuntimeError, match="Not connected"):
            await client.stop()

        with pytest.raises(RuntimeError, match="Not connected"):
            await client.send_audio(np.array([0], dtype=np.int16))
