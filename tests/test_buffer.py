"""Tests for audio buffer."""

import numpy as np

from voiceserver.audio.buffer import AudioBuffer
from voiceserver.protocol.constants import AUDIO_SAMPLE_RATE


class TestAudioBuffer:
    """Tests for AudioBuffer."""

    def test_empty_buffer(self) -> None:
        """Empty buffer returns empty array."""
        buffer = AudioBuffer()

        assert buffer.sample_count == 0
        assert buffer.duration_seconds == 0.0
        assert not buffer.has_audio()
        assert len(buffer.get_audio()) == 0
        assert len(buffer.get_audio_float32()) == 0

    def test_append_samples(self) -> None:
        """Appending samples accumulates them."""
        buffer = AudioBuffer()
        samples1 = np.array([100, 200, 300], dtype=np.int16)
        samples2 = np.array([400, 500], dtype=np.int16)

        buffer.append(0, samples1)
        buffer.append(1, samples2)

        assert buffer.sample_count == 5
        assert buffer.has_audio()
        np.testing.assert_array_equal(
            buffer.get_audio(),
            np.array([100, 200, 300, 400, 500], dtype=np.int16),
        )

    def test_get_audio_float32(self) -> None:
        """Float32 conversion normalizes to [-1, 1]."""
        buffer = AudioBuffer()
        # Max positive and max negative 16-bit values
        samples = np.array([32767, -32768, 0], dtype=np.int16)
        buffer.append(0, samples)

        float_samples = buffer.get_audio_float32()

        assert float_samples.dtype == np.float32
        assert float_samples[0] == pytest.approx(32767 / 32768, rel=1e-5)
        assert float_samples[1] == pytest.approx(-1.0, rel=1e-5)
        assert float_samples[2] == 0.0

    def test_duration_seconds(self) -> None:
        """Duration is calculated from sample count and rate."""
        buffer = AudioBuffer()
        # Add exactly 1 second of audio
        samples = np.zeros(AUDIO_SAMPLE_RATE, dtype=np.int16)
        buffer.append(0, samples)

        assert buffer.duration_seconds == pytest.approx(1.0)

    def test_clear(self) -> None:
        """Clear removes all samples."""
        buffer = AudioBuffer()
        samples = np.array([100, 200, 300], dtype=np.int16)
        buffer.append(0, samples)
        buffer.clear()

        assert buffer.sample_count == 0
        assert not buffer.has_audio()
        assert len(buffer.get_audio()) == 0

    def test_sequence_gap_detection(self) -> None:
        """Sequence gaps are detected."""
        buffer = AudioBuffer()
        samples = np.array([100], dtype=np.int16)

        buffer.append(0, samples)
        assert buffer.sequence_gaps == 0

        buffer.append(1, samples)  # No gap
        assert buffer.sequence_gaps == 0

        buffer.append(5, samples)  # Gap of 3 frames (2, 3, 4 missing)
        assert buffer.sequence_gaps == 1

        buffer.append(10, samples)  # Another gap
        assert buffer.sequence_gaps == 2

    def test_sequence_wrap(self) -> None:
        """Sequence numbers wrap at 65535."""
        buffer = AudioBuffer()
        samples = np.array([100], dtype=np.int16)

        buffer.append(65535, samples)
        buffer.append(0, samples)  # Wraps, no gap

        assert buffer.sequence_gaps == 0

    def test_sequence_gap_after_clear(self) -> None:
        """Sequence tracking continues after clear."""
        buffer = AudioBuffer()
        samples = np.array([100], dtype=np.int16)

        buffer.append(0, samples)
        buffer.append(1, samples)
        buffer.clear()
        buffer.append(2, samples)  # No gap even after clear

        assert buffer.sequence_gaps == 0


# Import pytest for approx
import pytest
