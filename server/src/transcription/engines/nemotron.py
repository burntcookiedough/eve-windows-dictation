"""NVIDIA Nemotron Speech batch engine."""

import gc
import logging
import os
import tempfile
import threading
import warnings

import numpy as np
import soundfile as sf
from numpy.typing import NDArray

from transcription.base import EngineInfo
from transcription.types import TranscribeResult

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000

# Loggers to suppress during model.transcribe() calls
_NOISY_LOGGERS = ["nemo_logger", "nemo", "lhotse", "lhotse.cut", "lhotse.dataset", "root"]


class NemotronEngine:
    def __init__(self, model_name: str, device: str = "auto") -> None:
        import torch
        import nemo.collections.asr as nemo_asr

        resolved_device = device
        if device == "auto":
            resolved_device = "cuda" if torch.cuda.is_available() else "cpu"

        logger.info("Loading Nemotron model: %s (device=%s)", model_name, resolved_device)

        self._model = nemo_asr.models.ASRModel.from_pretrained(model_name)
        self._model.eval()
        self._model = self._model.to(resolved_device)

        self._model_name = model_name
        self._device = resolved_device
        # Serialize model.transcribe() calls — NeMo's internal freeze/unfreeze
        # state corrupts when two calls overlap on the same model.
        self._model_lock = threading.Lock()

        logger.info("Nemotron model loaded successfully")

    @property
    def engine_info(self) -> EngineInfo:
        return EngineInfo(
            id="nemotron",
            name="Nemotron Speech",
            model=self._model_name,
            supports_hotwords=False,
            languages=["en"],
            model_size_gb=2.3,
        )

    def create_session(self) -> "NemotronSession":
        return NemotronSession(self._model, self._device, self._model_lock)

    def shutdown(self) -> None:
        logger.info("Shutting down Nemotron engine")
        del self._model
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


class NemotronSession:
    def __init__(self, model: object, device: str, model_lock: threading.Lock) -> None:
        self._model = model
        self._device = device
        self._model_lock = model_lock
        self._last_result = TranscribeResult(text="", confidence=0.0, last_speech_end=None)
        self._closed = False

    def transcribe(
        self,
        audio: NDArray[np.float32],
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult:
        import torch

        if self._closed or len(audio) == 0:
            return self._last_result

        audio_duration = len(audio) / SAMPLE_RATE

        # Write audio to temp WAV for the batch API
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
        try:
            os.close(tmp_fd)
            sf.write(tmp_path, audio, SAMPLE_RATE)

            # Suppress noisy NeMo/Lhotse loggers during transcription
            saved_levels = {}
            for name in _NOISY_LOGGERS:
                lg = logging.getLogger(name)
                saved_levels[name] = lg.level
                lg.setLevel(logging.ERROR)

            try:
                with self._model_lock:
                    # Freeze encoder before each call — NeMo's _transcribe_on_end()
                    # calls encoder.unfreeze(partial=True) which requires _frozen=True.
                    # Without this, the second+ call fails with ValueError.
                    self._model.encoder.freeze()
                    with warnings.catch_warnings():
                        warnings.filterwarnings("ignore", module="nemo")
                        warnings.filterwarnings("ignore", module="lhotse")
                        with torch.no_grad():
                            output = self._model.transcribe([tmp_path])
            finally:
                for name, level in saved_levels.items():
                    logging.getLogger(name).setLevel(level)

            # Extract text — output format varies by NeMo version
            text = ""
            result = output
            if isinstance(result, tuple):
                result = result[0]
            if isinstance(result, list) and len(result) > 0:
                item = result[0]
                text = getattr(item, "text", str(item))
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        self._last_result = TranscribeResult(
            text=text.strip(),
            confidence=0.95,
            last_speech_end=audio_duration if text.strip() else None,
        )
        return self._last_result

    def finalize(self) -> TranscribeResult:
        return self._last_result

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        # Release CUDA memory: gc.collect() frees NeMo DataLoader/CutSet
        # references, empty_cache() returns blocks to CUDA allocator.
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
