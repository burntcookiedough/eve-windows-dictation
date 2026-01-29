"""Client protocol layer - UI-independent, reusable."""

from .connection import VoiceClient
from .audio import MicrophoneCapture
from .global_hotkey import GlobalHotkeyListener
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
    "GlobalHotkeyListener",
    "ClientEvent",
    "ConnectedEvent",
    "ReadyEvent",
    "PartialEvent",
    "FinalEvent",
    "ClosingEvent",
    "ErrorEvent",
]
