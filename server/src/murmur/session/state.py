"""Session state machine with valid state transitions."""

from enum import StrEnum, auto


class SessionState(StrEnum):
    """States a transcription session can be in."""

    CONNECTED = auto()
    """Client connected, waiting for start frame."""

    STARTED = auto()
    """Start received, ready sent, accepting audio."""

    STREAMING = auto()
    """Actively receiving and transcribing audio."""

    FINALIZING = auto()
    """Processing final transcription before close."""

    CLOSED = auto()
    """Session ended."""


# Valid state transitions
_TRANSITIONS: dict[SessionState, set[SessionState]] = {
    SessionState.CONNECTED: {SessionState.STARTED, SessionState.CLOSED},
    SessionState.STARTED: {SessionState.STREAMING, SessionState.FINALIZING, SessionState.CLOSED},
    SessionState.STREAMING: {SessionState.FINALIZING, SessionState.CLOSED},
    SessionState.FINALIZING: {SessionState.CLOSED},
    SessionState.CLOSED: set(),  # Terminal state
}


class InvalidTransitionError(Exception):
    """Raised when an invalid state transition is attempted."""


class SessionStateMachine:
    """Manages session state transitions."""

    def __init__(self) -> None:
        """Initialize in CONNECTED state."""
        self._state = SessionState.CONNECTED

    @property
    def state(self) -> SessionState:
        """Get current session state."""
        return self._state

    def can_transition_to(self, target: SessionState) -> bool:
        """Check if a transition to the target state is valid."""
        return target in _TRANSITIONS[self._state]

    def transition_to(self, target: SessionState) -> None:
        """Transition to a new state.

        Args:
            target: The state to transition to.

        Raises:
            InvalidTransitionError: If the transition is not valid.
        """
        if not self.can_transition_to(target):
            raise InvalidTransitionError(f"Cannot transition from {self._state} to {target}")
        self._state = target

    def is_accepting_audio(self) -> bool:
        """Check if the session is in a state that accepts audio frames."""
        return self._state in {SessionState.STARTED, SessionState.STREAMING}

    def is_active(self) -> bool:
        """Check if the session is still active (not closed)."""
        return self._state != SessionState.CLOSED
