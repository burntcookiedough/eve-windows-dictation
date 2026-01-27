"""Error codes for the live transcription protocol."""

from enum import StrEnum


class ErrorCode(StrEnum):
    """Machine-readable error codes sent in error control frames."""

    NO_START = "no_start"
    """Audio frame received before start."""

    INVALID_START = "invalid_start"
    """Start frame malformed or missing required fields."""

    INVALID_AUDIO = "invalid_audio"
    """Audio frame malformed (bad header, wrong size)."""

    INVALID_CTRL = "invalid_ctrl"
    """Control frame is not valid JSON."""

    START_TIMEOUT = "start_timeout"
    """Client did not send start within allowed time after connecting."""

    RATE_LIMIT = "rate_limit"
    """Too many connections or requests."""

    INTERNAL = "internal"
    """Server-side error."""
