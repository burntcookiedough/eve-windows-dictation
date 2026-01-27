"""Client protocol layer - UI-independent, reusable."""

from .connection import VoiceClient
from .audio import MicrophoneCapture
from .types import (
    ClientEvent,
    ConnectedEvent,
    ReadyEvent,
    PartialEvent,
    FinalEvent,
    ClosingEvent,
    ErrorEvent,
)

__all__ = [
    "VoiceClient",
    "MicrophoneCapture",
    "ClientEvent",
    "ConnectedEvent",
    "ReadyEvent",
    "PartialEvent",
    "FinalEvent",
    "ClosingEvent",
    "ErrorEvent",
]
