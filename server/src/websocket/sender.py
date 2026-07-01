"""Helper for sending protocol frames over WebSocket."""

import logging
from typing import Any

from fastapi import WebSocket

from protocol.errors import ErrorCode
from protocol.frames import (
    ClosingFrame,
    ClosingReason,
    ErrorFrame,
    FinalTextFrame,
    PartialTextFrame,
    ReadyFrame,
    StatusFrame,
    StatusKind,
    WarningCode,
    WarningFrame,
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

    async def send_ready(self, engine_info: dict[str, Any] | None = None) -> None:
        """Send a ready control frame."""
        frame = ReadyFrame(engine=engine_info)
        data = frame.model_dump(exclude_none=True)
        await self._ws.send_json(data)
        logger.info("[%s] Sent ready frame", self._session_id)

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

    async def send_warning(self, code: WarningCode, message: str) -> None:
        """Send a non-fatal warning control frame."""
        frame = WarningFrame(code=code, message=message)
        await self._ws.send_json(frame.model_dump())
        logger.warning(
            "[%s] Sent warning frame: %s - %s", self._session_id, code, message
        )

    async def send_status(
        self,
        status: StatusKind,
        *,
        message: str | None = None,
        chunk_index: int | None = None,
        chunk_total: int | None = None,
        audio_duration: float | None = None,
    ) -> None:
        """Send a non-terminal status/progress control frame."""
        frame = StatusFrame(
            status=status,
            message=message,
            chunk_index=chunk_index,
            chunk_total=chunk_total,
            audio_duration=audio_duration,
        )
        await self._ws.send_json(frame.model_dump(exclude_none=True))
        logger.debug("[%s] Sent status frame: %s", self._session_id, status.value)

    async def send_closing(self, reason: ClosingReason) -> None:
        """Send a closing control frame.

        Args:
            reason: Reason for closing.
        """
        frame = ClosingFrame(reason=reason)
        await self._ws.send_json(frame.model_dump())
        logger.info("[%s] Sent closing frame: %s", self._session_id, reason.value)

    async def send_partial(
        self,
        text: str,
        confidence: float,
        transcription_time: float,
        audio_duration: float,
    ) -> None:
        """Send a partial text frame.

        Args:
            text: Partial transcription text.
            confidence: Confidence score (0.0 to 1.0).
            transcription_time: Time in seconds for transcription processing.
            audio_duration: Duration in seconds of the audio transcribed.
        """
        frame = PartialTextFrame(
            text=text,
            confidence=confidence,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
        )
        await self._ws.send_json(frame.model_dump())
        logger.debug(
            "[%s] Sent partial (%d chars): ...%r (conf=%.2f, time=%.3fs)",
            self._session_id,
            len(text),
            text[-60:],
            confidence,
            transcription_time,
        )

    async def send_final(
        self,
        text: str,
        confidence: float,
        transcription_time: float,
        audio_duration: float,
    ) -> None:
        """Send a final text frame.

        Args:
            text: Final transcription text (must be non-empty).
            confidence: Confidence score (0.0 to 1.0).
            transcription_time: Time in seconds for transcription processing.
            audio_duration: Duration in seconds of the audio transcribed.
        """
        frame = FinalTextFrame(
            text=text,
            confidence=confidence,
            transcription_time=transcription_time,
            audio_duration=audio_duration,
        )
        await self._ws.send_json(frame.model_dump())
        logger.info(
            "[%s] Sent final: %r (conf=%.2f, time=%.3fs)",
            self._session_id,
            text[:100],
            confidence,
            transcription_time,
        )
