"""Client-side event types for the voice transcription protocol."""

from dataclasses import dataclass
from typing import Callable, Protocol


@dataclass
class ClientEvent:
    """Base class for all client events."""
    pass


@dataclass
class ConnectedEvent(ClientEvent):
    """Emitted when WebSocket connection is established."""
    url: str


@dataclass
class ReadyEvent(ClientEvent):
    """Emitted when server confirms it's ready to receive audio."""
    pass


@dataclass
class PartialEvent(ClientEvent):
    """Emitted for interim transcription results."""
    text: str
    confidence: float


@dataclass
class FinalEvent(ClientEvent):
    """Emitted for committed transcription results."""
    text: str
    confidence: float


@dataclass
class ClosingEvent(ClientEvent):
    """Emitted when server is closing the connection."""
    reason: str


@dataclass
class ErrorEvent(ClientEvent):
    """Emitted when server sends an error."""
    code: str
    message: str


class EventCallback(Protocol):
    """Protocol for event callbacks."""
    def __call__(self, event: ClientEvent) -> None: ...
