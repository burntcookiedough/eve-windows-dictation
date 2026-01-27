"""Tests for session state machine."""

import pytest

from murmur.session.state import (
    InvalidTransitionError,
    SessionState,
    SessionStateMachine,
)


class TestSessionStateMachine:
    """Tests for SessionStateMachine."""

    def test_initial_state(self) -> None:
        """State machine starts in CONNECTED state."""
        sm = SessionStateMachine()
        assert sm.state == SessionState.CONNECTED

    def test_valid_transitions(self) -> None:
        """Test all valid state transitions."""
        # CONNECTED -> STARTED
        sm = SessionStateMachine()
        sm.transition_to(SessionState.STARTED)
        assert sm.state == SessionState.STARTED

        # STARTED -> STREAMING
        sm.transition_to(SessionState.STREAMING)
        assert sm.state == SessionState.STREAMING

        # STREAMING -> FINALIZING
        sm.transition_to(SessionState.FINALIZING)
        assert sm.state == SessionState.FINALIZING

        # FINALIZING -> CLOSED
        sm.transition_to(SessionState.CLOSED)
        assert sm.state == SessionState.CLOSED

    def test_connected_to_closed(self) -> None:
        """Can transition directly from CONNECTED to CLOSED."""
        sm = SessionStateMachine()
        sm.transition_to(SessionState.CLOSED)
        assert sm.state == SessionState.CLOSED

    def test_started_to_finalizing(self) -> None:
        """Can transition from STARTED to FINALIZING (no audio received)."""
        sm = SessionStateMachine()
        sm.transition_to(SessionState.STARTED)
        sm.transition_to(SessionState.FINALIZING)
        assert sm.state == SessionState.FINALIZING

    def test_started_to_closed(self) -> None:
        """Can transition directly from STARTED to CLOSED."""
        sm = SessionStateMachine()
        sm.transition_to(SessionState.STARTED)
        sm.transition_to(SessionState.CLOSED)
        assert sm.state == SessionState.CLOSED

    def test_streaming_to_closed(self) -> None:
        """Can transition directly from STREAMING to CLOSED."""
        sm = SessionStateMachine()
        sm.transition_to(SessionState.STARTED)
        sm.transition_to(SessionState.STREAMING)
        sm.transition_to(SessionState.CLOSED)
        assert sm.state == SessionState.CLOSED

    def test_invalid_transition_connected_to_streaming(self) -> None:
        """Cannot skip STARTED and go directly to STREAMING."""
        sm = SessionStateMachine()
        with pytest.raises(InvalidTransitionError):
            sm.transition_to(SessionState.STREAMING)

    def test_invalid_transition_connected_to_finalizing(self) -> None:
        """Cannot skip STARTED and go directly to FINALIZING."""
        sm = SessionStateMachine()
        with pytest.raises(InvalidTransitionError):
            sm.transition_to(SessionState.FINALIZING)

    def test_invalid_transition_from_closed(self) -> None:
        """Cannot transition from CLOSED to any state."""
        sm = SessionStateMachine()
        sm.transition_to(SessionState.CLOSED)

        for state in SessionState:
            with pytest.raises(InvalidTransitionError):
                sm.transition_to(state)

    def test_invalid_transition_backwards(self) -> None:
        """Cannot transition backwards."""
        sm = SessionStateMachine()
        sm.transition_to(SessionState.STARTED)
        sm.transition_to(SessionState.STREAMING)

        with pytest.raises(InvalidTransitionError):
            sm.transition_to(SessionState.STARTED)

    def test_can_transition_to(self) -> None:
        """Test can_transition_to method."""
        sm = SessionStateMachine()

        assert sm.can_transition_to(SessionState.STARTED)
        assert sm.can_transition_to(SessionState.CLOSED)
        assert not sm.can_transition_to(SessionState.STREAMING)
        assert not sm.can_transition_to(SessionState.FINALIZING)

    def test_is_accepting_audio(self) -> None:
        """Test is_accepting_audio method."""
        sm = SessionStateMachine()

        # CONNECTED: not accepting
        assert not sm.is_accepting_audio()

        # STARTED: accepting
        sm.transition_to(SessionState.STARTED)
        assert sm.is_accepting_audio()

        # STREAMING: accepting
        sm.transition_to(SessionState.STREAMING)
        assert sm.is_accepting_audio()

        # FINALIZING: not accepting
        sm.transition_to(SessionState.FINALIZING)
        assert not sm.is_accepting_audio()

        # CLOSED: not accepting
        sm.transition_to(SessionState.CLOSED)
        assert not sm.is_accepting_audio()

    def test_is_active(self) -> None:
        """Test is_active method."""
        sm = SessionStateMachine()

        assert sm.is_active()  # CONNECTED
        sm.transition_to(SessionState.STARTED)
        assert sm.is_active()  # STARTED
        sm.transition_to(SessionState.STREAMING)
        assert sm.is_active()  # STREAMING
        sm.transition_to(SessionState.FINALIZING)
        assert sm.is_active()  # FINALIZING
        sm.transition_to(SessionState.CLOSED)
        assert not sm.is_active()  # CLOSED
