"""Pydantic models for all protocol frame types."""

from enum import StrEnum
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field

from protocol.errors import ErrorCode


# --- Control Frames ---


class ControlFrameBase(BaseModel):
    """Base class for all control frames."""

    frame: Literal["control"] = "control"


class StartFrame(ControlFrameBase):
    """Client -> Server: Initiates a transcription session."""

    type: Literal["start"] = "start"
    silence_timeout: Annotated[
        float, Field(gt=0, description="Seconds of silence before auto-stop")
    ]
    partial_emission_interval: Annotated[
        float | None,
        Field(
            default=None,
            gt=0,
            description="Minimum seconds between partial emissions (uses server default if not provided)",
        ),
    ] = None
    hotwords: Annotated[
        str | None,
        Field(
            default=None,
            description="Optional hotwords to bias transcription toward custom terms",
        ),
    ] = None


class StopFrame(ControlFrameBase):
    """Client -> Server: Explicitly ends the session."""

    type: Literal["stop"] = "stop"


class ReadyFrame(ControlFrameBase):
    """Server -> Client: Confirms session started, server is accepting audio."""

    type: Literal["ready"] = "ready"
    engine: dict[str, Any] | None = None


class ErrorFrame(ControlFrameBase):
    """Server -> Client: Fatal error, connection will close immediately after."""

    type: Literal["error"] = "error"
    code: ErrorCode
    message: str


class WarningCode(StrEnum):
    """Machine-readable warning codes sent in non-fatal warning frames."""

    VRAM_EXHAUSTED = "vram_exhausted"
    """GPU VRAM was exhausted during transcription."""


class WarningFrame(ControlFrameBase):
    """Server -> Client: Non-fatal warning; session continues."""

    type: Literal["warning"] = "warning"
    code: WarningCode
    message: str


class ClosingReason(StrEnum):
    """Reasons for closing a session."""

    STOP_RECEIVED = "stop_received"
    """Client sent stop."""

    SILENCE_TIMEOUT = "silence_timeout"
    """No speech detected for configured duration."""


class ClosingFrame(ControlFrameBase):
    """Server -> Client: Server is about to close the connection."""

    type: Literal["closing"] = "closing"
    reason: ClosingReason


# Union type for all control frames
ControlFrame = Union[
    StartFrame,
    StopFrame,
    ReadyFrame,
    ErrorFrame,
    WarningFrame,
    ClosingFrame,
]


# --- Text Frames ---


class TextFrameBase(BaseModel):
    """Base class for all text frames."""

    frame: Literal["text"] = "text"


class PartialTextFrame(TextFrameBase):
    """Server -> Client: Interim transcription result (speculative, may change)."""

    type: Literal["partial"] = "partial"
    text: str
    confidence: Annotated[float, Field(ge=0.0, le=1.0)]
    transcription_time: Annotated[float, Field(ge=0.0)]
    audio_duration: Annotated[float, Field(ge=0.0)]


class FinalTextFrame(TextFrameBase):
    """Server -> Client: Committed transcription result (will not change)."""

    type: Literal["final"] = "final"
    text: Annotated[str, Field(min_length=1)]  # Never empty
    confidence: Annotated[float, Field(ge=0.0, le=1.0)]
    transcription_time: Annotated[float, Field(ge=0.0)]
    audio_duration: Annotated[float, Field(ge=0.0)]


# Union type for all text frames
TextFrame = Union[PartialTextFrame, FinalTextFrame]
