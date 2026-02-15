"""NVIDIA Nemotron Speech streaming engine."""

import logging

import numpy as np
from numpy.typing import NDArray

from transcription.base import AudioMode, EngineInfo, EngineSession, TranscriptionEngine
from transcription.types import TranscribeResult

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000

# Chunk size (ms) -> att_context_size [left_context_frames, right_context_frames]
CHUNK_CONFIGS: dict[int, list[int]] = {
    160: [70, 1],
    560: [70, 6],
    1120: [70, 13],
}


class NemotronEngine:
    audio_mode = AudioMode.INCREMENTAL

    def __init__(self, model_name: str, chunk_ms: int = 160, device: str = "auto") -> None:
        import torch
        import nemo.collections.asr as nemo_asr
        from omegaconf import open_dict

        if chunk_ms not in CHUNK_CONFIGS:
            raise ValueError(
                f"Unsupported chunk size: {chunk_ms}ms. "
                f"Supported: {sorted(CHUNK_CONFIGS.keys())}"
            )

        resolved_device = device
        if device == "auto":
            resolved_device = "cuda" if torch.cuda.is_available() else "cpu"

        logger.info("Loading Nemotron model: %s (chunk=%dms, device=%s)", model_name, chunk_ms, resolved_device)

        self._model = nemo_asr.models.ASRModel.from_pretrained(model_name)
        self._model.eval()
        self._model = self._model.to(resolved_device)

        # Configure streaming chunk size
        self._att_context = CHUNK_CONFIGS[chunk_ms]
        _apply_streaming_config(self._model, self._att_context)

        self._model_name = model_name
        self._chunk_ms = chunk_ms
        self._chunk_samples = int(chunk_ms * SAMPLE_RATE / 1000)
        self._device = resolved_device
        self._torch = torch

        logger.info("Nemotron model loaded successfully")

    @property
    def engine_info(self) -> EngineInfo:
        return EngineInfo(
            id="nemotron",
            name="Nemotron Speech",
            model=self._model_name,
            mode="streaming",
            supports_hotwords=False,
            languages=["en"],
            chunk_ms=self._chunk_ms,
            model_size_gb=2.3,
        )

    def create_session(self) -> "NemotronSession":
        cache_last_channel, cache_last_time, cache_last_channel_len = (
            self._model.encoder.get_initial_cache_state(batch_size=1)
        )
        cache_last_channel = cache_last_channel.to(self._device)
        cache_last_time = cache_last_time.to(self._device)
        cache_last_channel_len = cache_last_channel_len.to(self._device)

        return NemotronSession(
            model=self._model,
            cache_last_channel=cache_last_channel,
            cache_last_time=cache_last_time,
            cache_last_channel_len=cache_last_channel_len,
            chunk_samples=self._chunk_samples,
            device=self._device,
            att_context=self._att_context,
        )

    def shutdown(self) -> None:
        logger.info("Shutting down Nemotron engine")
        del self._model
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


class NemotronSession:
    def __init__(
        self,
        model: object,
        cache_last_channel: object,
        cache_last_time: object,
        cache_last_channel_len: object,
        chunk_samples: int,
        device: str,
        att_context: list[int],
    ) -> None:
        self._model = model
        self._cache_last_channel = cache_last_channel
        self._cache_last_time = cache_last_time
        self._cache_last_channel_len = cache_last_channel_len
        self._chunk_samples = chunk_samples
        self._device = device
        self._att_context = att_context
        self._accumulated_text = ""
        self._previous_hypotheses: object = None
        self._pred_out_stream: object = None
        self._total_samples_processed = 0
        self._leftover = np.array([], dtype=np.float32)
        self._closed = False

    def transcribe(
        self,
        audio: NDArray[np.float32],
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult:
        import torch

        if self._closed or len(audio) == 0:
            return TranscribeResult(
                text=self._accumulated_text.strip(),
                confidence=0.9,
                last_speech_end=self._total_samples_processed / SAMPLE_RATE if self._accumulated_text else None,
            )

        # Prepend leftover from previous call
        if len(self._leftover) > 0:
            audio = np.concatenate([self._leftover, audio])
            self._leftover = np.array([], dtype=np.float32)

        # Only process complete chunks — save remainder for next call
        num_complete = len(audio) // self._chunk_samples
        if num_complete == 0:
            self._leftover = audio
            return TranscribeResult(
                text=self._accumulated_text.strip(),
                confidence=0.9,
                last_speech_end=self._total_samples_processed / SAMPLE_RATE if self._accumulated_text else None,
            )

        # Save leftover sub-chunk audio for next call
        used = num_complete * self._chunk_samples
        if used < len(audio):
            self._leftover = audio[used:]

        self._process_chunks(torch, audio[:used])

        last_speech_end = self._total_samples_processed / SAMPLE_RATE if self._accumulated_text else None

        return TranscribeResult(
            text=self._accumulated_text.strip(),
            confidence=0.9,
            last_speech_end=last_speech_end,
        )

    def finalize(
        self, full_audio: NDArray[np.float32] | None = None,
    ) -> TranscribeResult:
        import torch

        if full_audio is not None and len(full_audio) > 0:
            # Fresh batch pass: re-transcribe all audio from scratch with clean cache.
            # This gives much higher quality than the streaming partials because the
            # model processes everything in a tight loop without gaps.
            return self._batch_retranscribe(torch, full_audio)

        # Fallback: flush leftover + silence to push out remaining tokens
        flush_samples = 3 * self._chunk_samples
        leftover = self._leftover if len(self._leftover) > 0 else np.array([], dtype=np.float32)
        self._leftover = np.array([], dtype=np.float32)

        if len(leftover) > 0:
            pad_needed = self._chunk_samples - len(leftover)
            padded_leftover = np.pad(leftover, (0, pad_needed))
            flush_audio = np.concatenate([padded_leftover, np.zeros(flush_samples, dtype=np.float32)])
        else:
            flush_audio = np.zeros(flush_samples, dtype=np.float32)

        self._process_chunks(torch, flush_audio)

        return TranscribeResult(
            text=self._accumulated_text.strip(),
            confidence=0.9,
            last_speech_end=self._total_samples_processed / SAMPLE_RATE if self._accumulated_text else None,
        )

    def _batch_retranscribe(
        self, torch: object, audio: NDArray[np.float32],
    ) -> TranscribeResult:
        """Re-transcribe full audio using model.transcribe() batch API.

        This is ~100x faster than streaming chunk-by-chunk and produces higher
        quality output since the model sees all audio context at once.

        IMPORTANT: model.transcribe() modifies internal model state (decoder
        config, attention context, etc.) which breaks conformer_stream_step()
        for subsequent sessions.  We restore streaming config after the call.
        """
        import tempfile
        import os
        import soundfile as sf

        # Write audio to temp WAV for the batch API
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
        try:
            os.close(tmp_fd)
            sf.write(tmp_path, audio, SAMPLE_RATE)

            with torch.no_grad():
                output = self._model.transcribe([tmp_path])

            # Extract text — output format varies by NeMo version
            text = ""
            result = output
            if isinstance(result, tuple):
                result = result[0]
            if isinstance(result, list) and len(result) > 0:
                item = result[0]
                text = getattr(item, "text", str(item))
        finally:
            # Always restore streaming config, even if transcribe() failed
            _apply_streaming_config(self._model, self._att_context)
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        audio_duration = len(audio) / SAMPLE_RATE
        return TranscribeResult(
            text=text.strip(),
            confidence=0.95,
            last_speech_end=audio_duration if text else None,
        )

    def _process_chunks(self, torch: object, audio: NDArray[np.float32]) -> None:
        """Process audio that is already aligned to chunk boundaries."""
        offset = 0
        while offset < len(audio):
            chunk = audio[offset:offset + self._chunk_samples]

            # Pad only if this is truly the last piece (finalize path)
            if len(chunk) < self._chunk_samples:
                chunk = np.pad(chunk, (0, self._chunk_samples - len(chunk)))

            chunk_tensor = torch.tensor(chunk, dtype=torch.float32).unsqueeze(0).to(self._device)
            chunk_length = torch.tensor([self._chunk_samples], dtype=torch.long).to(self._device)

            with torch.no_grad():
                processed_signal, processed_signal_length = self._model.preprocessor(
                    input_signal=chunk_tensor,
                    length=chunk_length,
                )

                (
                    self._pred_out_stream,
                    transcribed_texts,
                    self._cache_last_channel,
                    self._cache_last_time,
                    self._cache_last_channel_len,
                    self._previous_hypotheses,
                ) = self._model.conformer_stream_step(
                    processed_signal=processed_signal,
                    processed_signal_length=processed_signal_length,
                    cache_last_channel=self._cache_last_channel,
                    cache_last_time=self._cache_last_time,
                    cache_last_channel_len=self._cache_last_channel_len,
                    keep_all_outputs=False,
                    previous_hypotheses=self._previous_hypotheses,
                    previous_pred_out=self._pred_out_stream,
                    return_transcription=True,
                )

            current_text = _extract_text(transcribed_texts)
            if current_text:
                self._accumulated_text = current_text

            self._total_samples_processed += self._chunk_samples
            offset += self._chunk_samples

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._cache_last_channel = None
        self._cache_last_time = None
        self._cache_last_channel_len = None
        self._previous_hypotheses = None
        self._pred_out_stream = None


def _apply_streaming_config(model: object, att_context: list[int]) -> None:
    """Apply (or restore) streaming configuration on the model.

    model.transcribe() modifies the model's internal decoder state and encoder
    config, which breaks conformer_stream_step().  Call this after any batch
    transcription to put the model back into streaming mode.
    """
    from omegaconf import open_dict

    with open_dict(model.cfg):  # type: ignore[union-attr]
        model.cfg.encoder.att_context_size = att_context  # type: ignore[union-attr]
    if hasattr(model.encoder, "set_default_att_context_size"):  # type: ignore[union-attr]
        model.encoder.set_default_att_context_size(att_context)  # type: ignore[union-attr]

    model.preprocessor.featurizer.dither = 0.0  # type: ignore[union-attr]
    model.preprocessor.featurizer.pad_to = 0  # type: ignore[union-attr]


def _extract_text(transcribed_texts: object) -> str:
    if transcribed_texts is None:
        return ""
    if isinstance(transcribed_texts, list):
        item = transcribed_texts[0] if transcribed_texts else None
    else:
        item = transcribed_texts
    if item is None:
        return ""
    return getattr(item, "text", str(item))
