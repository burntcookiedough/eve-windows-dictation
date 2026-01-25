"""Tests for audio frame parsing."""

import struct

import numpy as np
import pytest

from voiceserver.audio.parser import AudioFrame, ParseError, parse_audio_frame
from voiceserver.protocol.constants import HEADER_SIZE


def make_audio_frame(sequence: int, samples: np.ndarray, flags: int = 0) -> bytes:
    """Create a binary audio frame."""
    sample_count = len(samples)
    header = struct.pack(">HHB", sequence, sample_count, flags)
    pcm_data = samples.astype("<i2").tobytes()
    return header + pcm_data


class TestParseAudioFrame:
    """Tests for parse_audio_frame function."""

    def test_parse_valid_frame(self) -> None:
        """Parse a valid audio frame."""
        samples = np.array([100, -200, 300, -400], dtype=np.int16)
        data = make_audio_frame(sequence=42, samples=samples)

        frame = parse_audio_frame(data)

        assert frame.sequence == 42
        assert frame.sample_count == 4
        assert frame.flags == 0
        np.testing.assert_array_equal(frame.samples, samples)

    def test_parse_empty_samples(self) -> None:
        """Parse a frame with zero samples."""
        samples = np.array([], dtype=np.int16)
        data = make_audio_frame(sequence=0, samples=samples)

        frame = parse_audio_frame(data)

        assert frame.sequence == 0
        assert frame.sample_count == 0
        assert len(frame.samples) == 0

    def test_parse_max_sequence(self) -> None:
        """Parse a frame with max sequence number."""
        samples = np.array([1, 2], dtype=np.int16)
        data = make_audio_frame(sequence=65535, samples=samples)

        frame = parse_audio_frame(data)

        assert frame.sequence == 65535

    def test_frame_too_short(self) -> None:
        """Reject frame shorter than header."""
        data = b"\x00\x01\x00"  # Only 3 bytes

        with pytest.raises(ParseError, match="too short"):
            parse_audio_frame(data)

    def test_invalid_flags(self) -> None:
        """Reject frame with non-zero flags."""
        samples = np.array([100], dtype=np.int16)
        data = make_audio_frame(sequence=0, samples=samples, flags=0x01)

        with pytest.raises(ParseError, match="Invalid flags"):
            parse_audio_frame(data)

    def test_pcm_size_mismatch_too_short(self) -> None:
        """Reject frame with PCM data shorter than header claims."""
        # Header says 10 samples, but only provide 2
        header = struct.pack(">HHB", 0, 10, 0)
        pcm_data = np.array([100, 200], dtype="<i2").tobytes()
        data = header + pcm_data

        with pytest.raises(ParseError, match="PCM size mismatch"):
            parse_audio_frame(data)

    def test_pcm_size_mismatch_too_long(self) -> None:
        """Reject frame with PCM data longer than header claims."""
        # Header says 2 samples, but provide 5
        header = struct.pack(">HHB", 0, 2, 0)
        pcm_data = np.array([100, 200, 300, 400, 500], dtype="<i2").tobytes()
        data = header + pcm_data

        with pytest.raises(ParseError, match="PCM size mismatch"):
            parse_audio_frame(data)

    def test_header_only_no_samples(self) -> None:
        """Parse header-only frame (0 samples declared)."""
        header = struct.pack(">HHB", 123, 0, 0)

        frame = parse_audio_frame(header)

        assert frame.sequence == 123
        assert frame.sample_count == 0
        assert len(frame.samples) == 0


class TestAudioFrameDataclass:
    """Tests for AudioFrame dataclass."""

    def test_frozen(self) -> None:
        """AudioFrame should be immutable."""
        frame = AudioFrame(
            sequence=1,
            sample_count=2,
            flags=0,
            samples=np.array([1, 2], dtype=np.int16),
        )

        with pytest.raises(AttributeError):
            frame.sequence = 999  # type: ignore
