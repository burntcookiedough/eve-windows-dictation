"""Helper for sending protocol frames over WebSocket."""

import logging

from fastapi import WebSocket

from protocol.errors import ErrorCode
from protocol.frames import (
    ClosingFrame,
    ClosingReason,
    ErrorFrame,
    FinalTextFrame,
    PartialTextFrame,
    ReadyFrame,
)

logger = logging.getLogger(__name__)


class FrameSender:
    """Helper for sending protocol frames over a WebSocket connection."""

    def __init__(self, websocket: WebSocket, session_id: str) -> None:
        """Initialize the sender.

        Args:
            websocket: The WebSocket connection.
            session_id: Session ID for logging.
        """
        self._ws = websocket
        self._session_id = session_id

    async def send_ready(self) -> None:
        """Send a ready control frame."""
        frame = ReadyFrame()
        await self._ws.send_json(frame.model_dump())
        logger.debug("[%s] Sent ready frame", self._session_id)

    async def send_error(self, code: ErrorCode, message: str) -> None:
        """Send an error control frame.

        Args:
            code: Error code.
            message: Human-readable error message.
        """
        frame = ErrorFrame(code=code, message=message)
        await self._ws.send_json(frame.model_dump())
        logger.warning(
            "[%s] Sent error frame: %s - %s", self._session_id, code, message
        )

    async def send_closing(self, reason: ClosingReason) -> None:
        """Send a closing control frame.

        Args:
            reason: Reason for closing.
        """
        frame = ClosingFrame(reason=reason)
        await self._ws.send_json(frame.model_dump())
        logger.debug("[%s] Sent closing frame: %s", self._session_id, reason)

    async def send_partial(self, text: str, confidence: float) -> None:
        """Send a partial text frame.

        Args:
            text: Partial transcription text.
            confidence: Confidence score (0.0 to 1.0).
        """
        frame = PartialTextFrame(text=text, confidence=confidence)
        await self._ws.send_json(frame.model_dump())
        logger.debug(
            "[%s] Sent partial: %r (conf=%.2f)", self._session_id, text[:50], confidence
        )

    async def send_final(self, text: str, confidence: float) -> None:
        """Send a final text frame.

        Args:
            text: Final transcription text (must be non-empty).
            confidence: Confidence score (0.0 to 1.0).
        """
        frame = FinalTextFrame(text=text, confidence=confidence)
        await self._ws.send_json(frame.model_dump())
        logger.info(
            "[%s] Sent final: %r (conf=%.2f)", self._session_id, text[:100], confidence
        )
