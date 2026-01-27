"""Protocol definitions for the live transcription WebSocket protocol."""

from murmur.protocol.constants import (
    AUDIO_CHANNELS,
    AUDIO_SAMPLE_RATE,
    BYTES_PER_SAMPLE,
    HEADER_SIZE,
)
from murmur.protocol.errors import ErrorCode
from murmur.protocol.frames import (
    ClosingFrame,
    ClosingReason,
    ControlFrame,
    ErrorFrame,
    FinalTextFrame,
    PartialTextFrame,
    ReadyFrame,
    StartFrame,
    StopFrame,
    TextFrame,
)

__all__ = [
    "AUDIO_CHANNELS",
    "AUDIO_SAMPLE_RATE",
    "BYTES_PER_SAMPLE",
    "HEADER_SIZE",
    "ClosingFrame",
    "ClosingReason",
    "ControlFrame",
    "ErrorCode",
    "ErrorFrame",
    "FinalTextFrame",
    "PartialTextFrame",
    "ReadyFrame",
    "StartFrame",
    "StopFrame",
    "TextFrame",
]
