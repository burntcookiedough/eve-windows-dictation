"""NVIDIA Nemotron Speech batch engine."""

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


class _NemoLogFilter(logging.Filter):
    """Block noisy NeMo/Lhotse messages from the root logger."""
    _BLOCKED = ("Lhotse CutSet", "Initializing Lhotse")

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(s in msg for s in self._BLOCKED)


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
        self._use_cuda = resolved_device != "cpu" and torch.cuda.is_available()
        # Serialize model.transcribe() calls — NeMo's internal freeze/unfreeze
        # state corrupts when two calls overlap on the same model.
        self._model_lock = threading.Lock()

        # Suppress [NeMo W] messages via NeMo's own logging API
        from nemo.utils import logging as nemo_logging
        nemo_logging.setLevel(logging.ERROR)

        # Suppress NeMo/Lhotse warnings (Python warnings module)
        warnings.filterwarnings("ignore", message=".*Lhotse.*")
        warnings.filterwarnings("ignore", message=".*non-tarred dataset.*")
        warnings.filterwarnings("ignore", message=".*Megatron.*")

        # Block noisy messages from root logger + NeMo/Lhotse loggers
        logging.getLogger().addFilter(_NemoLogFilter())
        for name in ["nemo_logger", "nemo", "lhotse", "lhotse.cut", "lhotse.dataset"]:
            logging.getLogger(name).setLevel(logging.ERROR)

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

            with self._model_lock:
                # Set the _frozen flag so _transcribe_on_end()'s call to
                # encoder.unfreeze(partial=True) won't raise ValueError.
                # Don't call freeze() — that changes requires_grad on all
                # params which breaks CUDA kernel selection and crashes.
                if hasattr(self._model, "encoder"):
                    self._model.encoder._frozen = True
                with torch.no_grad():
                    output = self._model.transcribe(
                        [tmp_path], verbose=False,
                    )

            # Extract text — output format varies by NeMo version
            text = ""
            result = output
            if isinstance(result, tuple):
                result = result[0]
            if isinstance(result, list) and len(result) > 0:
                item = result[0]
                text = getattr(item, "text", str(item))

            # Drop references to NeMo output so gc can free CUDA tensors
            del output, result
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
