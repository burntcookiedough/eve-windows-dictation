"""Streaming activity on the 16 kHz PCM sample clock."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from statistics import median
from typing import TYPE_CHECKING

import numpy as np
from numpy.typing import NDArray

if TYPE_CHECKING:
    from onnxruntime import InferenceSession

logger = logging.getLogger(__name__)

WINDOW_SAMPLES = 512
_CONTEXT_SAMPLES = 64
_SPEECH_THRESHOLD = 0.5
_CONTINUATION_THRESHOLD = 0.35
_RMS_HISTORY_WINDOWS = 64  # About two seconds of 32 ms windows.
_MIN_QUIET_WINDOWS = 3
_FALLBACK_NOISE_PERCENTILE = 20
_FALLBACK_NOISE_RATIO = 1.8
_FALLBACK_MIN_RMS = 0.001
_FALLBACK_MAX_RMS = 0.12
_FALLBACK_MAX_NOISE_RISE_PER_WINDOW = 0.00032  # 0.01 normalized RMS per second.
_STATIONARY_RMS_WINDOWS = 32  # About one second of steady energy.
_STATIONARY_RMS_RATIO = 1.15
_silero_session: InferenceSession | None = None


def _load_silero_session() -> InferenceSession:
    from faster_whisper.vad import get_vad_model

    return get_vad_model().session


async def warm_silero() -> None:
    """Load the shared inference session off the event loop before serving audio."""
    global _silero_session
    try:
        _silero_session = await asyncio.to_thread(_load_silero_session)
    except Exception:
        _silero_session = None
        logger.warning("Could not warm streaming Silero; speech activity will use energy")


class _SileroStream:
    """Carry the bundled model's recurrent state and context across deliveries."""

    def __init__(self) -> None:
        if _silero_session is None:
            raise RuntimeError("Streaming Silero is unavailable")
        self._session = _silero_session
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
        self.pause_noise_floor: float | None = None
        self._remainder = np.empty(0, dtype=np.float32)
        self._noise_rms: deque[float] = deque(maxlen=_RMS_HISTORY_WINDOWS)
        self._stationary_rms: deque[float] = deque(maxlen=_STATIONARY_RMS_WINDOWS)
        self._fallback_noise_floor: float | None = None
        self._quiet_rms: deque[float] = deque(maxlen=_RMS_HISTORY_WINDOWS)
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
        rms = np.sqrt(np.mean(np.square(frames), axis=1))

        if not self._use_energy:
            try:
                if self._silero is None:
                    self._silero = _SileroStream()
                scores = self._silero.probabilities(frames)
            except Exception:
                # Reprocess this delivery against the recent energy history.
                # The sample clock stays intact.
                logger.warning("Streaming Silero unavailable; using energy for speech activity")
                self._use_energy = True
                self._silero = None
            else:
                for score, energy in zip(scores, rms):
                    threshold = _CONTINUATION_THRESHOLD if self._active else _SPEECH_THRESHOLD
                    active = score >= threshold
                    if active:
                        if len(self._quiet_rms) >= _MIN_QUIET_WINDOWS:
                            floor = median(self._quiet_rms)
                            if self.pause_noise_floor is None or floor < self.pause_noise_floor:
                                self.pause_noise_floor = floor
                        self._quiet_rms.clear()
                    else:
                        # A pause never supplies the reference for its own seal.
                        self._quiet_rms.append(float(energy))
                        self._noise_rms.append(float(energy))
                    self._advance(active)
                return

        floor = self._fallback_noise_floor
        if floor is None:
            if self._noise_rms:
                floor = float(np.percentile(self._noise_rms, _FALLBACK_NOISE_PERCENTILE))
            else:
                floor = float(rms[0]) if self.processed_samples == 0 else 0.0
        for energy in rms:
            level = float(energy)
            self._stationary_rms.append(level)
            threshold = min(_FALLBACK_MAX_RMS, max(_FALLBACK_MIN_RMS, _FALLBACK_NOISE_RATIO * floor))
            active = level > threshold
            if active and len(self._stationary_rms) == _STATIONARY_RMS_WINDOWS:
                # A sustained, nearly constant level can be newly arrived fan noise.
                active = max(self._stationary_rms) > _STATIONARY_RMS_RATIO * min(self._stationary_rms)
            if not active:
                self._noise_rms.append(level)
                estimate = float(np.percentile(self._noise_rms, _FALLBACK_NOISE_PERCENTILE))
                floor = min(estimate, floor + _FALLBACK_MAX_NOISE_RISE_PER_WINDOW)
            self._advance(active)
        self._fallback_noise_floor = floor

    @property
    def silero_pause_start(self) -> int | None:
        """Only Silero activity can establish a boundary without overlap."""
        return self.last_speech_sample if self._silero is not None else None

    def _advance(self, active: bool) -> None:
        self.processed_samples += WINDOW_SAMPLES
        self._active = active
        if active:
            self.last_speech_sample = self.processed_samples
