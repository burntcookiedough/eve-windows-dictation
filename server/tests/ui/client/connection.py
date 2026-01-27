"""WebSocket connection management for voice transcription client."""

import asyncio
import json
import struct
from typing import Any, Callable

import numpy as np
import websockets
from websockets.asyncio.client import ClientConnection

from tests.ui.client.types import (
    ClientEvent,
    ConnectedEvent,
    ReadyEvent,
    PartialEvent,
    FinalEvent,
    ClosingEvent,
    ErrorEvent,
)

# Protocol constants (must match server)
HEADER_SIZE = 5
AUDIO_SAMPLE_RATE = 16000


class VoiceClient:
    """WebSocket client for voice transcription.

    Usage:
        client = VoiceClient()
        client.on_event = my_callback

        async with client.connect("ws://localhost:9867/ws"):
            await client.start(silence_timeout=5.0)
            # Send audio...
            await client.stop()
    """

    def __init__(self) -> None:
        self._ws: ClientConnection | None = None
        self._sequence: int = 0
        self._event_callback: Callable[[ClientEvent], None] | None = None
        self._receive_task: asyncio.Task | None = None
        self._ready_event: asyncio.Event = asyncio.Event()

    @property
    def on_event(self) -> Callable[[ClientEvent], None] | None:
        return self._event_callback

    @on_event.setter
    def on_event(self, callback: Callable[[ClientEvent], None] | None) -> None:
        self._event_callback = callback

    def _emit(self, event: ClientEvent) -> None:
        """Emit an event to the registered callback."""
        if self._event_callback:
            self._event_callback(event)

    async def connect(self, url: str) -> "VoiceClientContext":
        """Connect to the voice server.

        Returns an async context manager for the connection.
        """
        return VoiceClientContext(self, url)

    async def _connect(self, url: str) -> None:
        """Internal: establish WebSocket connection."""
        self._ws = await websockets.connect(url)
        self._sequence = 0
        self._ready_event.clear()
        self._emit(ConnectedEvent(url=url))

        # Start receive loop
        self._receive_task = asyncio.create_task(self._receive_loop())

    async def _disconnect(self) -> None:
        """Internal: close WebSocket connection."""
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
            self._receive_task = None

        if self._ws:
            await self._ws.close()
            self._ws = None

    async def _receive_loop(self) -> None:
        """Background task to receive and process server messages."""
        if not self._ws:
            return

        try:
            async for message in self._ws:
                if isinstance(message, str):
                    self._handle_json_message(message)
        except websockets.ConnectionClosed:
            pass

    def _handle_json_message(self, message: str) -> None:
        """Parse and handle a JSON message from the server."""
        try:
            data = json.loads(message)
        except json.JSONDecodeError:
            return

        frame_type = data.get("frame")
        msg_type = data.get("type")

        if frame_type == "control":
            if msg_type == "ready":
                self._ready_event.set()
                self._emit(ReadyEvent())
            elif msg_type == "closing":
                self._emit(ClosingEvent(reason=data.get("reason", "unknown")))
            elif msg_type == "error":
                self._emit(ErrorEvent(
                    code=data.get("code", "unknown"),
                    message=data.get("message", "Unknown error")
                ))
        elif frame_type == "text":
            if msg_type == "partial":
                self._emit(PartialEvent(
                    text=data.get("text", ""),
                    confidence=data.get("confidence", 0.0)
                ))
            elif msg_type == "final":
                self._emit(FinalEvent(
                    text=data.get("text", ""),
                    confidence=data.get("confidence", 0.0)
                ))

    async def start(self, silence_timeout: float = 5.0) -> None:
        """Send start frame and wait for ready confirmation."""
        if not self._ws:
            raise RuntimeError("Not connected")

        start_frame = {
            "frame": "control",
            "type": "start",
            "silence_timeout": silence_timeout
        }
        await self._ws.send(json.dumps(start_frame))

        # Wait for ready response
        await self._ready_event.wait()

    async def send_audio(self, samples: np.ndarray) -> None:
        """Send audio samples to the server.

        Args:
            samples: numpy array of int16 audio samples
        """
        if not self._ws:
            raise RuntimeError("Not connected")

        # Ensure correct dtype
        if samples.dtype != np.int16:
            samples = samples.astype(np.int16)

        # Build header: sequence (2), sample_count (2), flags (1)
        sample_count = len(samples)
        header = struct.pack(">HHB", self._sequence, sample_count, 0x00)

        # Increment sequence (wrap at 65535)
        self._sequence = (self._sequence + 1) & 0xFFFF

        # Send binary frame
        frame = header + samples.tobytes()
        await self._ws.send(frame)

    async def stop(self) -> None:
        """Send stop frame to end the session."""
        if not self._ws:
            raise RuntimeError("Not connected")

        stop_frame = {
            "frame": "control",
            "type": "stop"
        }
        await self._ws.send(json.dumps(stop_frame))


class VoiceClientContext:
    """Async context manager for VoiceClient connections."""

    def __init__(self, client: VoiceClient, url: str) -> None:
        self._client = client
        self._url = url

    async def __aenter__(self) -> VoiceClient:
        await self._client._connect(self._url)
        return self._client

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self._client._disconnect()
