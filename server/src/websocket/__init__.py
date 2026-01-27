"""WebSocket handling for the transcription server."""

from websocket.handler import websocket_handler
from websocket.sender import FrameSender

__all__ = [
    "FrameSender",
    "websocket_handler",
]
