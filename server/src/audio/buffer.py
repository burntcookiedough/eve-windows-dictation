"""Audio accumulator with bounded stdlib spooling, sequence tracking, and silence monitoring."""

import io
import logging
import tempfile
import threading
import time
from dataclasses import dataclass, field

import numpy as np
from numpy.typing import NDArray

from protocol.constants import (
    AUDIO_SAMPLE_RATE,
    BYTES_PER_SAMPLE,
    MAX_FRAME_SAMPLES,
)

logger = logging.getLogger(__name__)

# Bounded resident PCM capacity before spilling to disk (4 MiB = 2,097,152 samples = 131.072s ~= 2.18 minutes at 16kHz int16)
DEFAULT_MAX_RESIDENT_BYTES = 4 * 1024 * 1024


@dataclass
class AudioBuffer:
    """Accumulates PCM audio samples with bounded stdlib spooling, sequence gap detection, and silence tracking."""

    _max_resident_bytes: int = DEFAULT_MAX_RESIDENT_BYTES
    _total_samples: int = 0
    _last_sequence: int | None = None
    _sequence_gaps: int = 0
    _last_audio_time: float = field(default_factory=time.monotonic)
    _closed: bool = False

    def __post_init__(self) -> None:
        if self._max_resident_bytes <= 0:
            raise ValueError(f"max_resident_bytes must be positive, got {self._max_resident_bytes}")
        self._lock = threading.Lock()
        self._file: tempfile.SpooledTemporaryFile | None = None
        self._init_spool()

    def _init_spool(self) -> None:
        try:
            self._file = tempfile.SpooledTemporaryFile(
                max_size=self._max_resident_bytes,
                mode="w+b",
            )
        except Exception:
            self._cleanup_file()
            self._closed = True
            raise

    def append(self, sequence: int, samples: NDArray[np.int16]) -> None:
        """Add audio samples to the buffer.

        Args:
            sequence: Frame sequence number (for gap detection).
            samples: PCM samples to append.
        """
        with self._lock:
            if self._closed or self._file is None:
                raise RuntimeError("AudioBuffer is closed")

            sample_count = len(samples)
            if sample_count == 0:
                if self._last_sequence is not None:
                    expected = (self._last_sequence + 1) % 65536
                    if sequence != expected:
                        self._sequence_gaps += 1
                self._last_sequence = sequence
                self._last_audio_time = time.monotonic()
                return

            try:
                self._file.seek(0, io.SEEK_END)
                for offset in range(0, sample_count, MAX_FRAME_SAMPLES):
                    chunk = samples[offset : offset + MAX_FRAME_SAMPLES]
                    raw_bytes = chunk.astype("<i2", copy=False).tobytes()
                    written = self._file.write(raw_bytes)
                    if written != len(raw_bytes):
                        raise OSError(f"Short write: wrote {written} of {len(raw_bytes)} bytes")

                if self._last_sequence is not None:
                    expected = (self._last_sequence + 1) % 65536
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
                self._total_samples += sample_count
                self._last_audio_time = time.monotonic()
            except Exception:
                self._cleanup_file()
                self._closed = True
                self._total_samples = 0
                raise

    def _read_range_int16_locked(
        self, start_sample: int, end_sample: int, *, copy: bool = True
    ) -> NDArray[np.int16]:
        if self._closed or self._file is None or self._total_samples == 0:
            return np.array([], dtype=np.int16)

        start = max(0, start_sample)
        end = min(self._total_samples, end_sample)
        if start >= end:
            return np.array([], dtype=np.int16)

        num_samples = end - start
        expected_bytes = num_samples * BYTES_PER_SAMPLE
        self._file.seek(start * BYTES_PER_SAMPLE, io.SEEK_SET)
        raw_bytes = self._file.read(expected_bytes)

        if len(raw_bytes) != expected_bytes:
            raise OSError(
                f"Short read: expected {expected_bytes} bytes for range [{start}:{end}], got {len(raw_bytes)} bytes"
            )

        arr = np.frombuffer(raw_bytes, dtype="<i2")
        return arr.copy() if copy else arr

    def get_audio_range_int16(self, start_sample: int, end_sample: int) -> NDArray[np.int16]:
        """Get a range of accumulated audio as int16 samples.

        Args:
            start_sample: Starting sample offset (inclusive).
            end_sample: Ending sample offset (exclusive).

        Returns:
            PCM int16 samples in requested range.
        """
        with self._lock:
            return self._read_range_int16_locked(start_sample, end_sample, copy=True)

    def get_audio_range_float32(self, start_sample: int, end_sample: int) -> NDArray[np.float32]:
        """Get a range of accumulated audio as normalized float32 samples.

        Args:
            start_sample: Starting sample offset (inclusive).
            end_sample: Ending sample offset (exclusive).

        Returns:
            Samples normalized to [-1.0, 1.0] range for Whisper.
        """
        with self._lock:
            int16_samples = self._read_range_int16_locked(start_sample, end_sample, copy=False)
            if len(int16_samples) == 0:
                return np.array([], dtype=np.float32)
            return int16_samples.astype(np.float32) / 32768.0

    def get_audio(self) -> NDArray[np.int16]:
        """Get all accumulated audio samples as a single array.

        Returns:
            Concatenated PCM samples, or empty array if no audio.
        """
        with self._lock:
            return self._read_range_int16_locked(0, self._total_samples, copy=True)

    def get_audio_float32(self) -> NDArray[np.float32]:
        """Get all accumulated audio as normalized float32 samples.

        Returns:
            Samples normalized to [-1.0, 1.0] range for Whisper.
        """
        with self._lock:
            int16_samples = self._read_range_int16_locked(0, self._total_samples, copy=False)
            if len(int16_samples) == 0:
                return np.array([], dtype=np.float32)
            return int16_samples.astype(np.float32) / 32768.0

    def get_audio_tail_float32(self, max_samples: int) -> NDArray[np.float32]:
        """Get a bounded tail of accumulated audio as float32 samples.

        Only samples needed for the requested tail are read and converted;
        earlier retained audio is not materialized into memory.
        """
        with self._lock:
            if max_samples <= 0 or self._closed or self._file is None or self._total_samples == 0:
                return np.array([], dtype=np.float32)

            total = self._total_samples
            tail_samples = min(max_samples, total)
            start_sample = total - tail_samples
            int16_samples = self._read_range_int16_locked(start_sample, total, copy=False)
            if len(int16_samples) == 0:
                return np.array([], dtype=np.float32)
            return int16_samples.astype(np.float32) / 32768.0

    def __len__(self) -> int:
        """Return total sample count."""
        return self._total_samples

    def clear(self) -> None:
        """Clear all accumulated audio, preserving sequence tracking and allowing reuse."""
        with self._lock:
            self._cleanup_file()
            self._total_samples = 0
            self._closed = False
            self._init_spool()

    def close(self) -> None:
        """Close backing store and release all temporary resources idempotently."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._cleanup_file()
            self._total_samples = 0

    def _cleanup_file(self) -> None:
        """Safely close and dereference the underlying file."""
        if self._file is not None:
            try:
                self._file.close()
            except Exception as e:
                logger.debug("Error closing spool file: %s", e)
            finally:
                self._file = None

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
