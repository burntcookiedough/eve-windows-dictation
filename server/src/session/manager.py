"""Session lifecycle management with concurrency limits."""

import logging
import threading
from typing import Iterator

from config import get_settings
from session.context import SessionContext

logger = logging.getLogger(__name__)

# Global session manager
_manager: "SessionManager | None" = None
_manager_lock = threading.Lock()


class SessionLimitError(Exception):
    """Raised when the maximum number of sessions is reached."""


class SessionManager:
    """Manages active transcription sessions with concurrency limits."""

    def __init__(self, max_sessions: int) -> None:
        """Initialize the session manager.

        Args:
            max_sessions: Maximum number of concurrent sessions.
        """
        self._max_sessions = max_sessions
        self._sessions: dict[str, SessionContext] = {}
        self._lock = threading.Lock()

    @property
    def active_count(self) -> int:
        """Get number of active sessions."""
        with self._lock:
            return len(self._sessions)

    @property
    def max_sessions(self) -> int:
        """Get maximum allowed sessions."""
        return self._max_sessions

    def create_session(self) -> SessionContext:
        """Create a new session.

        Returns:
            New SessionContext.

        Raises:
            SessionLimitError: If max sessions reached.
        """
        with self._lock:
            if len(self._sessions) >= self._max_sessions:
                raise SessionLimitError(
                    f"Maximum sessions ({self._max_sessions}) reached"
                )

            context = SessionContext()
            self._sessions[context.session_id] = context
            logger.info(
                "Session created: %s (active: %d/%d)",
                context.session_id,
                len(self._sessions),
                self._max_sessions,
            )
            return context

    def remove_session(self, session_id: str) -> None:
        """Remove a session.

        Args:
            session_id: ID of session to remove.
        """
        with self._lock:
            if session_id in self._sessions:
                del self._sessions[session_id]
                logger.info(
                    "Session removed: %s (active: %d/%d)",
                    session_id,
                    len(self._sessions),
                    self._max_sessions,
                )

    def get_session(self, session_id: str) -> SessionContext | None:
        """Get a session by ID.

        Args:
            session_id: ID of session to get.

        Returns:
            SessionContext if found, None otherwise.
        """
        with self._lock:
            return self._sessions.get(session_id)

    def iter_sessions(self) -> Iterator[SessionContext]:
        """Iterate over all active sessions.

        Yields:
            Active SessionContext instances.
        """
        with self._lock:
            yield from list(self._sessions.values())


def get_session_manager() -> SessionManager:
    """Get the global SessionManager instance, creating it if needed."""
    global _manager

    if _manager is not None:
        return _manager

    with _manager_lock:
        # Double-check after acquiring lock
        if _manager is not None:
            return _manager

        settings = get_settings()
        _manager = SessionManager(max_sessions=settings.max_sessions)
        return _manager
