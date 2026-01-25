"""Binary audio frame parsing with header validation."""

import struct
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from voiceserver.protocol.constants import BYTES_PER_SAMPLE, HEADER_SIZE


class ParseError(Exception):
    """Raised when an audio frame cannot be parsed."""


@dataclass(frozen=True, slots=True)
class AudioFrame:
    """Parsed audio frame with header fields and PCM samples."""

    sequence: int
    sample_count: int
    flags: int
    samples: NDArray[np.int16]


def parse_audio_frame(data: bytes) -> AudioFrame:
    """Parse a binary audio frame into its components.

    Args:
        data: Raw binary frame data (header + PCM samples).

    Returns:
        Parsed AudioFrame with sequence, sample count, flags, and samples.

    Raises:
        ParseError: If the frame is malformed.
    """
    if len(data) < HEADER_SIZE:
        raise ParseError(f"Frame too short: {len(data)} bytes, need at least {HEADER_SIZE}")

    # Parse header (big-endian): sequence(u16), sample_count(u16), flags(u8)
    sequence, sample_count, flags = struct.unpack(">HHB", data[:HEADER_SIZE])

    # Validate flags (must be 0x00)
    if flags != 0x00:
        raise ParseError(f"Invalid flags: 0x{flags:02x}, expected 0x00")

    # Validate PCM data size
    expected_pcm_size = sample_count * BYTES_PER_SAMPLE
    actual_pcm_size = len(data) - HEADER_SIZE

    if actual_pcm_size != expected_pcm_size:
        raise ParseError(
            f"PCM size mismatch: header says {sample_count} samples ({expected_pcm_size} bytes), "
            f"but got {actual_pcm_size} bytes"
        )

    # Parse PCM samples (little-endian 16-bit signed integers)
    pcm_data = data[HEADER_SIZE:]
    samples = np.frombuffer(pcm_data, dtype="<i2")

    return AudioFrame(
        sequence=sequence,
        sample_count=sample_count,
        flags=flags,
        samples=samples,
    )
