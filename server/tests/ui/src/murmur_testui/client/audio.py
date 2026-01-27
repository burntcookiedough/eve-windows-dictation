"""Microphone capture using sounddevice."""

import logging
import threading
from collections.abc import Generator

import numpy as np
import sounddevice as sd

# Audio format (must match server spec)
SAMPLE_RATE = 16000
CHANNELS = 1
DTYPE = np.int16

logger = logging.getLogger("murmur_testui.audio")


class MicrophoneCapture:
    """Cross-platform microphone capture using sounddevice.

    Usage:
        mic = MicrophoneCapture()
        mic.start()
        for chunk in mic.chunks():
            process(chunk)
        mic.stop()
    """

    def __init__(self, chunk_ms: int = 20) -> None:
        """Initialize microphone capture.

        Args:
            chunk_ms: Chunk size in milliseconds (default 20ms = 320 samples at 16kHz)
        """
        self._chunk_samples = int(SAMPLE_RATE * chunk_ms / 1000)
        self._stream: sd.InputStream | None = None
        self._running = False
        self._lock = threading.Lock()

    @property
    def chunk_samples(self) -> int:
        """Number of samples per chunk."""
        return self._chunk_samples

    def start(self) -> None:
        """Start microphone capture."""
        with self._lock:
            if self._stream is not None:
                logger.debug("Microphone already started")
                return

            logger.debug("Starting microphone capture")
            self._stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype=DTYPE,
                blocksize=self._chunk_samples,
            )
            self._stream.start()
            self._running = True
            logger.debug("Microphone capture started")

    def stop(self) -> None:
        """Stop microphone capture."""
        with self._lock:
            self._running = False
            if self._stream is not None:
                logger.debug("Stopping microphone capture")
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception as e:
                    logger.warning("Error stopping microphone stream: %s", e)
                finally:
                    self._stream = None
                logger.debug("Microphone capture stopped")
            else:
                logger.debug("Microphone already stopped")

    def read_chunk(self) -> np.ndarray | None:
        """Read a single chunk of audio.

        Returns:
            numpy array of int16 samples, or None if not running
        """
        if not self._running or self._stream is None:
            return None

        data, overflowed = self._stream.read(self._chunk_samples)
        # Flatten to 1D array
        return data.flatten()

    def chunks(self) -> Generator[np.ndarray, None, None]:
        """Generator that yields audio chunks while running."""
        while self._running:
            chunk = self.read_chunk()
            if chunk is not None:
                yield chunk


def load_wav_file(path: str) -> tuple[np.ndarray, int]:
    """Load a WAV file and return samples and sample rate.

    Args:
        path: Path to WAV file

    Returns:
        Tuple of (samples as int16 array, sample rate)
    """
    import wave

    with wave.open(path, 'rb') as wav:
        sample_rate = wav.getframerate()
        n_frames = wav.getnframes()
        n_channels = wav.getnchannels()
        sample_width = wav.getsampwidth()

        raw_data = wav.readframes(n_frames)

        # Convert to numpy array
        if sample_width == 2:
            samples = np.frombuffer(raw_data, dtype=np.int16)
        elif sample_width == 1:
            samples = np.frombuffer(raw_data, dtype=np.uint8).astype(np.int16) - 128
            samples = samples * 256
        else:
            raise ValueError(f"Unsupported sample width: {sample_width}")

        # Convert stereo to mono if needed
        if n_channels == 2:
            samples = samples.reshape(-1, 2).mean(axis=1).astype(np.int16)

        return samples, sample_rate


def resample_audio(samples: np.ndarray, src_rate: int, dst_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Resample audio to target sample rate.

    Args:
        samples: Input samples
        src_rate: Source sample rate
        dst_rate: Target sample rate (default 16kHz)

    Returns:
        Resampled samples as int16 array
    """
    if src_rate == dst_rate:
        return samples

    # Simple linear interpolation resampling
    duration = len(samples) / src_rate
    n_samples_out = int(duration * dst_rate)

    indices = np.linspace(0, len(samples) - 1, n_samples_out)
    resampled = np.interp(indices, np.arange(len(samples)), samples.astype(np.float32))

    return resampled.astype(np.int16)
