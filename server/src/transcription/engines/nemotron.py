"""NVIDIA Nemotron Speech batch engine."""

import faulthandler
import logging
import os
import sys
import tempfile
import threading
import warnings

import numpy as np
import soundfile as sf
from numpy.typing import NDArray

from transcription.base import EngineInfo
from transcription.errors import VramExhaustedError
from transcription.model_download import is_repo_cached, update_model_download_state
from transcription.types import TranscribeOptions, TranscribeResult

logger = logging.getLogger(__name__)

_NETWORK_ERROR_MARKERS = ("TLS", "SSL", "certificate", "ConnectionError", "urlopen")
_MODEL_SIZE_GB = 2.3


def _iter_exception_chain(exc: BaseException) -> list[BaseException]:
    """Walk exception causes/contexts without raising on None."""
    seen: set[int] = set()
    stack = [exc]
    chain: list[BaseException] = []
    while stack:
        current = stack.pop()
        if current is None:
            continue
        current_id = id(current)
        if current_id in seen:
            continue
        seen.add(current_id)
        chain.append(current)
        stack.append(current.__context__)
        stack.append(current.__cause__)
    return chain


def _resolve_repo_id(model: str) -> str | None:
    if os.path.exists(model):
        return None
    if "/" in model:
        return model
    return None


def _is_network_error(exc: BaseException) -> bool:
    """Detect TLS/network errors that offline loading can recover from."""
    for e in _iter_exception_chain(exc):
        msg = str(e)
        if any(marker.lower() in msg.lower() for marker in _NETWORK_ERROR_MARKERS):
            return True
    return False

SAMPLE_RATE = 16000

# Enable faulthandler so native crashes (SIGSEGV, SIGABRT) print a
# Python traceback to stderr instead of silently exiting with code 1.
faulthandler.enable(file=sys.stderr)


class _BlockAllFilter(logging.Filter):
    """Block all log records. Attached to NeMo's handlers to silence spam.

    We use handler-level filters (not logger-level setLevel) because NeMo's
    _transcribe_on_begin() resets handler *levels* to WARNING on every call,
    but it never touches handler *filters*.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return False


class _BlockNemoRootFilter(logging.Filter):
    """Block NeMo/Lhotse messages that leak to the root logger."""

    _BLOCKED = (
        "Initializing Lhotse",
        "Lhotse CutSet",
        "Lhotse dataloader",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(s in msg for s in self._BLOCKED)


def _suppress_nemo_logging() -> None:
    """Silence NeMo/Lhotse/nv_one_logger output permanently."""
    block = _BlockAllFilter()

    # Block [NeMo W/I] messages by filtering NeMo's own StreamHandlers.
    nemo_log = logging.getLogger("nemo_logger")
    for handler in nemo_log.handlers:
        handler.addFilter(block)

    # Suppress related loggers via level (these don't get reset by NeMo).
    for name in ["nv_one_logger", "lhotse", "lhotse.cut", "lhotse.dataset"]:
        logging.getLogger(name).setLevel(logging.ERROR)

    # Block Lhotse messages that leak to root logger (not through nemo_logger).
    logging.getLogger().addFilter(_BlockNemoRootFilter())


class NemotronEngine:
    def __init__(self, model_name: str, device: str = "auto") -> None:
        import torch

        repo_id = _resolve_repo_id(model_name)
        preflight_cached: bool | None = None
        if repo_id:
            preflight_cached = is_repo_cached(repo_id)
            if preflight_cached:
                update_model_download_state(
                    model=model_name,
                    size_gb=_MODEL_SIZE_GB,
                    status="ready",
                    cached=True,
                    detail="cached; loading model",
                    repo_id=repo_id,
                    phase="loading",
                    progress_percent=100.0,
                )
            else:
                update_model_download_state(
                    model=model_name,
                    size_gb=_MODEL_SIZE_GB,
                    status="downloading",
                    cached=False,
                    detail="download started",
                    repo_id=repo_id,
                    phase="downloading",
                )
                logger.info(
                    "Nemotron model not found in cache; downloading (~%.1f GB).",
                    _MODEL_SIZE_GB,
                )
        else:
            update_model_download_state(
                model=model_name,
                size_gb=_MODEL_SIZE_GB,
                status="ready",
                cached=True,
                detail="local model; loading",
                phase="loading",
                progress_percent=100.0,
            )

        # Suppress Python warnings from NeMo/Lhotse before import triggers them.
        warnings.filterwarnings("ignore", message=".*Lhotse.*")
        warnings.filterwarnings("ignore", message=".*non-tarred.*")
        warnings.filterwarnings("ignore", message=".*Megatron.*")
        warnings.filterwarnings("ignore", message=".*OneLogger.*")

        # Pre-suppress nv_one_logger before NeMo import fires warnings.
        logging.getLogger("nv_one_logger").setLevel(logging.ERROR)

        import nemo.collections.asr as nemo_asr

        # Now that NeMo's Logger singleton exists with its handlers,
        # add blocking filters that persist across transcribe() calls.
        _suppress_nemo_logging()

        resolved_device = device
        if device == "auto":
            resolved_device = "cuda" if torch.cuda.is_available() else "cpu"

        logger.info("Loading Nemotron model: %s (device=%s)", model_name, resolved_device)

        try:
            self._model = nemo_asr.models.ASRModel.from_pretrained(model_name)
        except Exception as exc:
            if _is_network_error(exc):
                logger.warning(
                    "Network/TLS error loading model, retrying with local cache: %s", exc,
                )
                old_val = os.environ.get("HF_HUB_OFFLINE")
                os.environ["HF_HUB_OFFLINE"] = "1"
                try:
                    self._model = nemo_asr.models.ASRModel.from_pretrained(model_name)
                except Exception as offline_exc:
                    if preflight_cached is False:
                        update_model_download_state(
                            model=model_name,
                            size_gb=_MODEL_SIZE_GB,
                            status="error",
                            cached=False,
                            detail="download failed: network error",
                            repo_id=repo_id,
                            phase="error",
                        )
                    raise offline_exc from exc
                finally:
                    if old_val is None:
                        os.environ.pop("HF_HUB_OFFLINE", None)
                    else:
                        os.environ["HF_HUB_OFFLINE"] = old_val
            else:
                if preflight_cached is False:
                    update_model_download_state(
                        model=model_name,
                        size_gb=_MODEL_SIZE_GB,
                        status="error",
                        cached=False,
                        detail="download failed",
                        repo_id=repo_id,
                        phase="error",
                    )
                raise
        self._model.eval()
        self._model = self._model.to(resolved_device)

        # Disable persistent dataloader workers to reduce CUDA memory pressure.
        from omegaconf import open_dict

        with open_dict(self._model.cfg):
            for ds_key in ["test_ds", "validation_ds", "train_ds"]:
                if ds_key in self._model.cfg:
                    self._model.cfg[ds_key].num_workers = 0

        self._model_name = model_name
        self._device = resolved_device
        self._use_cuda = resolved_device != "cpu" and torch.cuda.is_available()
        # Serialize model.transcribe() calls — NeMo's internal freeze/unfreeze
        # state corrupts when two calls overlap on the same model.
        self._model_lock = threading.Lock()

        if preflight_cached is False:
            detail = "downloaded"
        elif preflight_cached is True:
            detail = "cached"
        else:
            detail = "local model"
        update_model_download_state(
            model=model_name,
            size_gb=_MODEL_SIZE_GB,
            status="ready",
            cached=True,
            detail=detail,
            repo_id=repo_id,
            phase="ready",
            progress_percent=100.0,
        )
        if preflight_cached is False:
            logger.info("Nemotron model download complete.")
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
        # Reclaim VRAM from previous sessions.  NeMo's RNNT decoder uses
        # CUDA graphs that hold GPU memory references — calling empty_cache()
        # without disabling them first causes a native crash (SIGSEGV).
        # See: https://github.com/NVIDIA-NeMo/NeMo/issues/14727
        if self._use_cuda:
            import torch

            # Model inference uses the same lock. Mutating CUDA graph state or
            # clearing its allocator during native inference can crash NeMo.
            with self._model_lock:
                self._model.disable_cuda_graphs()
                try:
                    torch.cuda.empty_cache()
                finally:
                    self._model.maybe_enable_cuda_graphs()
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
        options: TranscribeOptions | None = None,
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

                try:
                    with torch.no_grad():
                        output = self._model.transcribe(
                            [tmp_path], verbose=False,
                        )
                except torch.cuda.OutOfMemoryError as error:
                    logger.warning(
                        "CUDA OOM during model.transcribe() (audio=%.1fs); "
                        "falling back to last successful result",
                        audio_duration,
                    )
                    raise VramExhaustedError(last_result=self._last_result) from error
                except Exception:
                    logger.error(
                        "model.transcribe() failed (audio=%.1fs)",
                        audio_duration,
                        exc_info=True,
                    )
                    return self._last_result

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
