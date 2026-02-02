"""Per-session data container bundling all session state."""

import time
import uuid
from dataclasses import dataclass, field

from audio.buffer import AudioBuffer
from session.state import SessionStateMachine


@dataclass
class SessionContext:
    """Container for all per-session state."""

    # Unique session identifier
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    # Session state machine
    state_machine: SessionStateMachine = field(default_factory=SessionStateMachine)

    # Audio buffer for accumulating samples
    audio_buffer: AudioBuffer = field(default_factory=AudioBuffer)

    # Configuration from start frame
    silence_timeout: float = 5.0

    # Timestamps
    created_at: float = field(default_factory=time.monotonic)
    started_at: float | None = None

    # Speech timing for silence detection
    audio_start_time: float | None = None  # Monotonic time when first audio arrived
    last_speech_time: float | None = None  # Monotonic time when speech was last detected

    # Last transcription result (for partial emissions)
    last_partial_text: str = ""

    # Flag to track if we've sent any speech
    has_speech: bool = False

    def mark_started(self) -> None:
        """Mark the session as started."""
        self.started_at = time.monotonic()

    @property
    def duration_since_start(self) -> float | None:
        """Get seconds since session started, or None if not started."""
        if self.started_at is None:
            return None
        return time.monotonic() - self.started_at
