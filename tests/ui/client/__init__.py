"""Client protocol layer - UI-independent, reusable."""

from tests.ui.client.connection import VoiceClient
from tests.ui.client.audio import MicrophoneCapture
from tests.ui.client.types import (
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
