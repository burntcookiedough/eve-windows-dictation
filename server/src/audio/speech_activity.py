"""Streaming activity on the 16 kHz PCM sample clock."""

import logging

import numpy as np
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

WINDOW_SAMPLES = 512
_CONTEXT_SAMPLES = 64
_SPEECH_THRESHOLD = 0.5
_CONTINUATION_THRESHOLD = 0.35
_FALLBACK_RMS_THRESHOLD = 0.01


class _SileroStream:
    """Carry the bundled model's recurrent state and context across deliveries."""

    def __init__(self) -> None:
        # Keep the import lazy so a missing optional runtime can fall back.
        from faster_whisper.vad import get_vad_model

        self._session = get_vad_model().session
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros_like(self._h)
        self._context = np.zeros(_CONTEXT_SAMPLES, dtype=np.float32)

    def probabilities(self, frames: NDArray[np.float32]) -> NDArray[np.float32]:
        rows = np.empty((len(frames), _CONTEXT_SAMPLES + WINDOW_SAMPLES), dtype=np.float32)
        rows[0, :_CONTEXT_SAMPLES] = self._context
        rows[1:, :_CONTEXT_SAMPLES] = frames[:-1, -_CONTEXT_SAMPLES:]
        rows[:, _CONTEXT_SAMPLES:] = frames
        scores, self._h, self._c = self._session.run(
            None, {"input": rows, "h": self._h, "c": self._c},
        )
        self._context = frames[-1, -_CONTEXT_SAMPLES:].copy()
        scores = scores.reshape(-1)
        if len(scores) != len(frames) or not np.all(np.isfinite(scores)):
            raise ValueError("Invalid streaming Silero output")
        return scores


class SpeechActivity:
    """Track complete PCM windows once, retaining less than one window of PCM."""

    def __init__(self) -> None:
        self.processed_samples = 0
        self.last_speech_sample: int | None = None
        self._remainder = np.empty(0, dtype=np.float32)
        self._silero: _SileroStream | None = None
        self._use_energy = False
        self._active = False

    def append(self, samples: NDArray[np.int16]) -> None:
        audio = np.concatenate((self._remainder, samples.astype(np.float32) / 32768.0))
        complete = len(audio) // WINDOW_SAMPLES * WINDOW_SAMPLES
        self._remainder = audio[complete:].copy()
        if complete == 0:
            return
        frames = audio[:complete].reshape(-1, WINDOW_SAMPLES)

        if not self._use_energy:
            try:
                if self._silero is None:
                    self._silero = _SileroStream()
                scores = self._silero.probabilities(frames)
            except Exception:
                # Reprocess only this delivery and use fixed, per-window RMS
                # for the rest of the session. The sample clock stays intact.
                logger.warning("Streaming Silero unavailable; using energy for speech activity")
                self._use_energy = True
                self._silero = None
            else:
                for score in scores:
                    threshold = _CONTINUATION_THRESHOLD if self._active else _SPEECH_THRESHOLD
                    self._advance(score >= threshold)
                return

        rms = np.sqrt(np.mean(np.square(frames), axis=1))
        for energy in rms:
            self._advance(energy >= _FALLBACK_RMS_THRESHOLD)

    @property
    def silero_pause_start(self) -> int | None:
        """Only Silero activity can establish a boundary without overlap."""
        return self.last_speech_sample if self._silero is not None else None

    def _advance(self, active: bool) -> None:
        self.processed_samples += WINDOW_SAMPLES
        self._active = active
        if active:
            self.last_speech_sample = self.processed_samples
