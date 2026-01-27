"""Audio accumulator with sequence tracking and silence monitoring."""

import logging
import time
from dataclasses import dataclass, field

import numpy as np
from numpy.typing import NDArray

from murmur.protocol.constants import AUDIO_SAMPLE_RATE

logger = logging.getLogger(__name__)


@dataclass
class AudioBuffer:
    """Accumulates PCM audio samples with sequence gap detection and silence tracking."""

    _chunks: list[NDArray[np.int16]] = field(default_factory=list)
    _total_samples: int = 0
    _last_sequence: int | None = None
    _sequence_gaps: int = 0
    _last_audio_time: float = field(default_factory=time.monotonic)

    def append(self, sequence: int, samples: NDArray[np.int16]) -> None:
        """Add audio samples to the buffer.

        Args:
            sequence: Frame sequence number (for gap detection).
            samples: PCM samples to append.
        """
        # Detect sequence gaps
        if self._last_sequence is not None:
            expected = (self._last_sequence + 1) % 65536  # Wraps at 65535
            if sequence != expected:
                gap = (sequence - expected) % 65536
                self._sequence_gaps += 1
                logger.debug(
                    "Sequence gap detected: expected %d, got %d (gap of %d frames)",
                    expected,
                    sequence,
                    gap,
                )

        self._last_sequence = sequence
        self._chunks.append(samples)
        self._total_samples += len(samples)
        self._last_audio_time = time.monotonic()

    def get_audio(self) -> NDArray[np.int16]:
        """Get all accumulated audio samples as a single array.

        Returns:
            Concatenated PCM samples, or empty array if no audio.
        """
        if not self._chunks:
            return np.array([], dtype=np.int16)
        return np.concatenate(self._chunks)

    def get_audio_float32(self) -> NDArray[np.float32]:
        """Get all accumulated audio as normalized float32 samples.

        Returns:
            Samples normalized to [-1.0, 1.0] range for Whisper.
        """
        samples = self.get_audio()
        if len(samples) == 0:
            return np.array([], dtype=np.float32)
        return samples.astype(np.float32) / 32768.0

    def clear(self) -> None:
        """Clear all accumulated audio."""
        self._chunks.clear()
        self._total_samples = 0
        # Keep sequence tracking for gap detection across clears

    @property
    def duration_seconds(self) -> float:
        """Get total duration of buffered audio in seconds."""
        return self._total_samples / AUDIO_SAMPLE_RATE

    @property
    def sample_count(self) -> int:
        """Get total number of samples in buffer."""
        return self._total_samples

    @property
    def sequence_gaps(self) -> int:
        """Get number of sequence gaps detected."""
        return self._sequence_gaps

    @property
    def seconds_since_last_audio(self) -> float:
        """Get seconds elapsed since last audio was received."""
        return time.monotonic() - self._last_audio_time

    def has_audio(self) -> bool:
        """Check if buffer contains any audio."""
        return self._total_samples > 0
