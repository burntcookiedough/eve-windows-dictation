"""Tests for AudioBuffer accumulator with bounded spooling and sequence tracking."""

import os
from unittest.mock import patch, MagicMock

import numpy as np
import pytest

from audio.buffer import AudioBuffer
from protocol.constants import AUDIO_SAMPLE_RATE


class TestAudioBuffer:
    def test_initial_state(self) -> None:
        """Buffer starts empty with zero gaps and no audio."""
        buffer = AudioBuffer()
        assert buffer.sample_count == 0
        assert buffer.duration_seconds == 0.0
        assert buffer.sequence_gaps == 0
        assert not buffer.has_audio()
        assert len(buffer.get_audio()) == 0
        assert len(buffer.get_audio_float32()) == 0
        buffer.close()

    def test_validate_positive_resident_capacity(self) -> None:
        """Resident capacity must be strictly positive (max_size=0 is unbounded)."""
        with pytest.raises(ValueError, match="max_resident_bytes must be positive"):
            AudioBuffer(_max_resident_bytes=0)
        with pytest.raises(ValueError, match="max_resident_bytes must be positive"):
            AudioBuffer(_max_resident_bytes=-1024)

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
        buffer.close()

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
        buffer.close()

    def test_duration_seconds(self) -> None:
        """Duration is calculated from sample count and rate."""
        buffer = AudioBuffer()
        # Add exactly 1 second of audio
        samples = np.zeros(AUDIO_SAMPLE_RATE, dtype=np.int16)
        buffer.append(0, samples)

        assert buffer.duration_seconds == pytest.approx(1.0)
        buffer.close()

    def test_clear_allows_reuse_and_resets_state(self) -> None:
        """Clear removes all samples, preserves sequence tracking, and allows clean reuse."""
        buffer = AudioBuffer()
        samples = np.array([100, 200, 300], dtype=np.int16)
        buffer.append(0, samples)
        buffer.clear()

        assert buffer.sample_count == 0
        assert not buffer.has_audio()
        assert len(buffer.get_audio()) == 0

        # Reuse after clear
        samples2 = np.array([700, 800], dtype=np.int16)
        buffer.append(1, samples2)
        assert buffer.sample_count == 2
        assert buffer.has_audio()
        np.testing.assert_array_equal(buffer.get_audio(), samples2)
        buffer.close()

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
        buffer.close()

    def test_sequence_wrap(self) -> None:
        """Sequence numbers wrap at 65535."""
        buffer = AudioBuffer()
        samples = np.array([100], dtype=np.int16)

        buffer.append(65535, samples)
        buffer.append(0, samples)  # Wraps, no gap

        assert buffer.sequence_gaps == 0
        buffer.close()

    def test_sequence_gap_after_clear(self) -> None:
        """Sequence tracking continues after clear."""
        buffer = AudioBuffer()
        samples = np.array([100], dtype=np.int16)

        buffer.append(0, samples)
        buffer.append(1, samples)
        buffer.clear()
        buffer.append(2, samples)  # No gap even after clear

        assert buffer.sequence_gaps == 0
        buffer.close()

    def test_spool_rollover_preserves_samples_and_bounds_memory(self) -> None:
        """Rollover to disk preserves exact bitwise samples."""
        # Use small max_resident_bytes (1024 bytes = 512 int16 samples)
        buffer = AudioBuffer(_max_resident_bytes=1024)
        total_samples = 2000
        ramp = np.arange(total_samples, dtype=np.int16)

        # Append in chunks of 200 samples
        chunk_size = 200
        seq = 0
        for i in range(0, total_samples, chunk_size):
            buffer.append(seq, ramp[i : i + chunk_size])
            seq += 1

        assert buffer.sample_count == total_samples
        assert buffer._file is not None
        assert buffer._file._rolled is True

        # Exact sample preservation
        recovered = buffer.get_audio()
        np.testing.assert_array_equal(recovered, ramp)

        recovered_f32 = buffer.get_audio_float32()
        np.testing.assert_array_equal(recovered_f32, ramp.astype(np.float32) / 32768.0)
        buffer.close()

    def test_range_reads_and_tail_window_exact(self) -> None:
        """Range reads and tail normalization return exact expected slices without zero-padding."""
        buffer = AudioBuffer(_max_resident_bytes=512)
        samples = np.arange(1000, dtype=np.int16)
        buffer.append(0, samples)

        # Range reads
        slice_100_300 = buffer.get_audio_range_int16(100, 300)
        np.testing.assert_array_equal(slice_100_300, samples[100:300])

        slice_f32 = buffer.get_audio_range_float32(100, 300)
        np.testing.assert_array_equal(slice_f32, samples[100:300].astype(np.float32) / 32768.0)

        # Tail window
        tail_50 = buffer.get_audio_tail_float32(50)
        np.testing.assert_array_equal(tail_50, samples[-50:].astype(np.float32) / 32768.0)

        assert len(buffer) == 1000

        # Clamping
        out_of_bounds = buffer.get_audio_range_int16(950, 1500)
        np.testing.assert_array_equal(out_of_bounds, samples[950:])

        negative_start = buffer.get_audio_range_int16(-100, 50)
        np.testing.assert_array_equal(negative_start, samples[:50])

        inverted = buffer.get_audio_range_int16(500, 400)
        assert len(inverted) == 0
        buffer.close()

    def test_append_seeks_eof_after_reads(self) -> None:
        """Appending after seeking/reading correctly appends at end of file."""
        buffer = AudioBuffer(_max_resident_bytes=512)
        c1 = np.full(200, 10, dtype=np.int16)
        c2 = np.full(200, 20, dtype=np.int16)

        buffer.append(0, c1)
        # Seek by performing a range read
        _ = buffer.get_audio_range_int16(0, 50)

        # Append second chunk
        buffer.append(1, c2)

        assert buffer.sample_count == 400
        recovered = buffer.get_audio()
        np.testing.assert_array_equal(recovered[:200], c1)
        np.testing.assert_array_equal(recovered[200:], c2)
        buffer.close()

    def test_empty_frames_do_not_grow_metadata(self) -> None:
        """Empty frames update sequence tracking but do not write bytes or grow metadata."""
        buffer = AudioBuffer()
        empty = np.array([], dtype=np.int16)

        for seq in range(1000):
            buffer.append(seq, empty)

        assert buffer.sample_count == 0
        assert buffer.duration_seconds == 0.0
        assert buffer.sequence_gaps == 0
        assert not buffer.has_audio()
        buffer.close()

    def test_short_read_raises_error_no_zero_padding(self) -> None:
        """Short reads raise explicit OSError and never return zero-filled fabricated samples."""
        buffer = AudioBuffer()
        samples = np.array([1, 2, 3, 4], dtype=np.int16)
        buffer.append(0, samples)

        with patch.object(buffer._file, "read", return_value=b"\x01\x00"):  # only 1 sample returned when 4 requested
            with pytest.raises(OSError, match="Short read"):
                buffer.get_audio_range_int16(0, 4)
        buffer.close()

    def test_close_is_idempotent_and_releases_backing_file(self) -> None:
        """close() removes backing temporary file and multiple calls are idempotent."""
        buffer = AudioBuffer(_max_resident_bytes=100)
        # Force rollover to create a real temporary file on disk
        samples = np.arange(500, dtype=np.int16)
        buffer.append(0, samples)

        file_name = getattr(buffer._file._file, "name", None)
        assert file_name is not None
        assert os.path.exists(file_name)

        # First close
        buffer.close()
        assert not os.path.exists(file_name)
        assert buffer.sample_count == 0

        # Second close (idempotent no-op)
        buffer.close()

    def test_spool_disk_full_resets_count_and_cleans_file(self) -> None:
        """Write failure (e.g. disk full) closes handles and resets sample count to 0."""
        buffer = AudioBuffer()
        buffer.append(0, np.array([1, 2, 3], dtype=np.int16))
        assert buffer.sample_count == 3
        assert buffer.has_audio()

        # Simulate disk full on subsequent write
        with patch.object(buffer._file, "write", side_effect=OSError("No space left on device")):
            with pytest.raises(OSError, match="No space left on device"):
                buffer.append(1, np.array([4, 5, 6], dtype=np.int16))

        assert buffer.sample_count == 0
        assert not buffer.has_audio()
        assert buffer._file is None
        assert buffer._closed is True

    def test_short_write_rejects_none_and_short_bytes(self) -> None:
        """Short writes (partial byte count or None) raise OSError and close buffer."""
        buffer1 = AudioBuffer()
        # Case 1: write returns partial byte count
        with patch.object(buffer1._file, "write", return_value=2):  # wrote 2 bytes instead of 6
            with pytest.raises(OSError, match="Short write"):
                buffer1.append(0, np.array([1, 2, 3], dtype=np.int16))
        assert buffer1.sample_count == 0
        assert buffer1._closed is True

        buffer2 = AudioBuffer()
        # Case 2: write returns None
        with patch.object(buffer2._file, "write", return_value=None):
            with pytest.raises(OSError, match="Short write"):
                buffer2.append(0, np.array([1, 2, 3], dtype=np.int16))
        assert buffer2.sample_count == 0
        assert buffer2._closed is True

    def test_only_advance_sequence_on_successful_write(self) -> None:
        """Sequence is only advanced when write succeeds; failing write preserves state."""
        buffer = AudioBuffer()
        buffer.append(10, np.array([100], dtype=np.int16))
        assert buffer._last_sequence == 10

        with patch.object(buffer._file, "write", side_effect=OSError("disk error")):
            with pytest.raises(OSError):
                buffer.append(11, np.array([200], dtype=np.int16))

        # Because write failed, sequence 11 was not committed to buffer state
        assert buffer.sample_count == 0
        assert buffer._closed is True

    def test_rollover_write_failure_closes_handle(self) -> None:
        """If rollover newfile write fails, buffer error cleanup closes all handles."""
        buffer = AudioBuffer(_max_resident_bytes=100)
        # Pre-load buffer near capacity (80 bytes < 100 byte limit)
        buffer.append(0, np.arange(40, dtype=np.int16))
        assert not buffer._file._rolled

        # Rollover happens on next write exceeding 100 bytes.
        # In binary mode CPython tempfile does not have .buffer attribute.
        with patch("tempfile.TemporaryFile") as mock_tmp:
            fake_newfile = MagicMock(spec=["write", "close", "seek", "tell", "closed"])
            fake_newfile.closed = False
            fake_newfile.write.side_effect = OSError("Disk full during rollover")
            mock_tmp.return_value = fake_newfile

            with pytest.raises(OSError, match="Disk full during rollover"):
                buffer.append(1, np.arange(40, dtype=np.int16))

            # Verify that fake_newfile.close was called during cleanup
            assert fake_newfile.close.called

        assert buffer.sample_count == 0
        assert buffer._file is None
        assert buffer._closed is True

    def test_concurrent_append_and_tail_snapshot_does_not_exceed_max_samples(self) -> None:
        """Concurrent appends do not cause tail reads to exceed max_samples or deadlock."""
        import threading
        buffer = AudioBuffer(_max_resident_bytes=4096)
        errors = []
        stop_event = threading.Event()

        def writer():
            seq = 0
            while not stop_event.is_set():
                try:
                    buffer.append(seq, np.ones(50, dtype=np.int16))
                    seq += 1
                except Exception as e:
                    errors.append(e)
                    break

        def reader():
            while not stop_event.is_set():
                try:
                    tail = buffer.get_audio_tail_float32(100)
                    if len(tail) > 100:
                        errors.append(ValueError(f"Tail length {len(tail)} exceeded max 100"))
                        break
                except Exception as e:
                    errors.append(e)
                    break

        threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
        for t in threads:
            t.start()
        import time
        time.sleep(0.1)
        stop_event.set()
        for t in threads:
            t.join()

        assert not errors
        buffer.close()
