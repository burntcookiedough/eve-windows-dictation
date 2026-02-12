"""Cache-aware streaming transcription using Nemotron Speech.

Demonstrates the incremental streaming API:
1. Loads model and initializes encoder cache state
2. Splits WAV into fixed-size chunks
3. Feeds each chunk through preprocessor -> conformer_stream_step
4. Prints partial results as they're produced
5. Reports per-chunk latency

Chunk size is configured via --chunk-ms (80, 160, 560, 1120).
Each frame in the FastConformer encoder = 80ms of audio (after 8x downsampling
of 10ms mel-spectrogram frames).

Usage:
    python transcribe_streaming.py samples/test.wav
    python transcribe_streaming.py samples/test.wav --chunk-ms 160
    python transcribe_streaming.py samples/test.wav --chunk-ms 80 --quiet
"""

from __future__ import annotations

import argparse
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import nemo.collections.asr as nemo_asr
from omegaconf import open_dict

# Chunk size (ms) -> att_context_size [left_context_frames, right_context_frames]
# left=70 gives the model 70 * 80ms = 5.6s of cached left context.
# right=N means N additional encoder frames of look-ahead per chunk.
# NOTE: 80ms chunks crash — the model's 8x subsampling needs ≥160ms of audio
# to produce at least 1 encoder output frame.
CHUNK_CONFIGS: dict[int, list[int]] = {
    160: [70, 1],
    560: [70, 6],
    1120: [70, 13],
}

SAMPLE_RATE = 16000


@dataclass
class StreamResult:
    """Result of streaming transcription."""

    text: str
    chunk_latencies: list[float]  # seconds per chunk
    total_time: float  # seconds
    num_chunks: int
    vram_peak_gb: float | None  # None if CPU


def load_audio(path: str | Path) -> np.ndarray:
    """Load audio file as float32 mono at 16kHz."""
    audio, sr = sf.read(str(path), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        # Resample via torchaudio
        import torchaudio

        audio_tensor = torch.tensor(audio).unsqueeze(0)
        resampler = torchaudio.transforms.Resample(sr, SAMPLE_RATE)
        audio = resampler(audio_tensor).squeeze(0).numpy()
    return audio


def configure_streaming(model: nemo_asr.models.ASRModel, chunk_ms: int) -> list[int]:
    """Configure model for cache-aware streaming with the given chunk size.

    Returns the att_context_size that was set.
    """
    if chunk_ms not in CHUNK_CONFIGS:
        raise ValueError(
            f"Unsupported chunk size: {chunk_ms}ms. "
            f"Supported: {sorted(CHUNK_CONFIGS.keys())}"
        )

    att_context = CHUNK_CONFIGS[chunk_ms]

    # Update encoder's attention context size in the OmegaConf config
    with open_dict(model.cfg):
        model.cfg.encoder.att_context_size = att_context

    # Apply to the live encoder module
    if hasattr(model.encoder, "set_default_att_context_size"):
        model.encoder.set_default_att_context_size(att_context)

    return att_context


def stream_transcribe(
    model: nemo_asr.models.ASRModel,
    audio: np.ndarray,
    chunk_ms: int,
    *,
    device: str = "cuda",
    verbose: bool = True,
) -> StreamResult:
    """Run cache-aware streaming transcription on an audio array.

    Args:
        model: Loaded and eval-mode Nemotron ASR model.
        audio: Float32 audio samples at 16kHz.
        chunk_ms: Chunk size in milliseconds (must be in CHUNK_CONFIGS).
        device: "cuda" or "cpu".
        verbose: Print per-chunk partial results.

    Returns:
        StreamResult with text, latencies, timing, and VRAM info.
    """
    chunk_samples = int(chunk_ms * SAMPLE_RATE / 1000)
    num_chunks = max(1, int(np.ceil(len(audio) / chunk_samples)))

    if verbose:
        duration = len(audio) / SAMPLE_RATE
        print(f"Audio: {duration:.2f}s ({len(audio)} samples)")
        print(f"Chunk: {chunk_ms}ms ({chunk_samples} samples)")
        print(f"Chunks: {num_chunks}")
        print()

    # --- Initialize encoder cache ---
    cache_last_channel, cache_last_time, cache_last_channel_len = (
        model.encoder.get_initial_cache_state(batch_size=1)
    )
    cache_last_channel = cache_last_channel.to(device)
    cache_last_time = cache_last_time.to(device)
    cache_last_channel_len = cache_last_channel_len.to(device)

    # --- Prepare preprocessor ---
    # Use the model's own preprocessor (mel-spectrogram extractor).
    # Disable dither for deterministic output and disable padding.
    preprocessor = model.preprocessor
    preprocessor.featurizer.dither = 0.0
    preprocessor.featurizer.pad_to = 0

    # --- Streaming state ---
    previous_hypotheses = None
    pred_out_stream = None
    chunk_latencies: list[float] = []
    last_text = ""

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    total_start = time.perf_counter()

    for i in range(num_chunks):
        chunk_start = i * chunk_samples
        chunk_end = min(chunk_start + chunk_samples, len(audio))
        chunk = audio[chunk_start:chunk_end]

        # Pad the final chunk to full size
        if len(chunk) < chunk_samples:
            chunk = np.pad(chunk, (0, chunk_samples - len(chunk)))

        # Waveform -> tensor [1, samples]
        chunk_tensor = (
            torch.tensor(chunk, dtype=torch.float32).unsqueeze(0).to(device)
        )
        chunk_length = torch.tensor([chunk_samples], dtype=torch.long).to(device)

        with torch.no_grad():
            # Preprocessor: waveform -> mel-spectrogram features
            processed_signal, processed_signal_length = preprocessor(
                input_signal=chunk_tensor,
                length=chunk_length,
            )

            # Streaming inference step
            t0 = time.perf_counter()
            (
                pred_out_stream,
                transcribed_texts,
                cache_last_channel,
                cache_last_time,
                cache_last_channel_len,
                previous_hypotheses,
            ) = model.conformer_stream_step(
                processed_signal=processed_signal,
                processed_signal_length=processed_signal_length,
                cache_last_channel=cache_last_channel,
                cache_last_time=cache_last_time,
                cache_last_channel_len=cache_last_channel_len,
                keep_all_outputs=False,
                previous_hypotheses=previous_hypotheses,
                previous_pred_out=pred_out_stream,
                return_transcription=True,
            )
            if device == "cuda":
                torch.cuda.synchronize()

        chunk_latency = time.perf_counter() - t0
        chunk_latencies.append(chunk_latency)

        # Extract text from streaming step output
        current_text = _extract_text(transcribed_texts)

        if verbose and current_text != last_text:
            chunk_time_s = chunk_start / SAMPLE_RATE
            print(
                f"  [{chunk_time_s:6.2f}s] ({chunk_latency * 1000:5.1f}ms) "
                f"{current_text}"
            )
            last_text = current_text
        elif current_text:
            last_text = current_text

    total_time = time.perf_counter() - total_start

    vram_peak: float | None = None
    if device == "cuda":
        vram_peak = torch.cuda.max_memory_allocated() / 1024**3

    return StreamResult(
        text=last_text,
        chunk_latencies=chunk_latencies,
        total_time=total_time,
        num_chunks=num_chunks,
        vram_peak_gb=vram_peak,
    )


def _extract_text(transcribed_texts: object) -> str:
    """Extract a plain string from conformer_stream_step output.

    The return type varies across NeMo versions. RNNT models return
    Hypothesis objects (with a .text attribute) in a list.
    """
    if transcribed_texts is None:
        return ""
    if isinstance(transcribed_texts, list):
        item = transcribed_texts[0] if transcribed_texts else None
    else:
        item = transcribed_texts
    if item is None:
        return ""
    # Hypothesis objects have a .text attribute
    return getattr(item, "text", str(item))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cache-aware streaming transcription with Nemotron Speech"
    )
    parser.add_argument("audio_file", help="Path to WAV file (16kHz mono)")
    parser.add_argument(
        "--chunk-ms",
        type=int,
        default=560,
        choices=sorted(CHUNK_CONFIGS.keys()),
        help="Chunk size in milliseconds (default: %(default)s)",
    )
    parser.add_argument(
        "--model",
        default="nvidia/nemotron-speech-streaming-en-0.6b",
        help="Model name or path (default: %(default)s)",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress per-chunk output",
    )
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")
    if device == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
    else:
        print(
            "WARNING: Nemotron Speech is designed for GPU inference. "
            "CPU mode may be very slow."
        )

    # Load model
    print(f"Loading model: {args.model}")
    t0 = time.perf_counter()
    model = nemo_asr.models.ASRModel.from_pretrained(args.model)
    model.eval()
    model = model.to(device)
    load_time = time.perf_counter() - t0
    print(f"Model loaded in {load_time:.1f}s")

    if device == "cuda":
        vram_model = torch.cuda.memory_allocated() / 1024**3
        print(f"VRAM (model): {vram_model:.2f} GB")

    # Configure streaming
    att_context = configure_streaming(model, args.chunk_ms)
    print(
        f"Streaming: chunk={args.chunk_ms}ms, "
        f"att_context_size={att_context}"
    )

    # Load audio
    audio = load_audio(args.audio_file)
    print(f"Audio file: {args.audio_file} ({len(audio) / SAMPLE_RATE:.2f}s)")
    print()

    # Run streaming transcription
    print("--- Streaming Transcription ---")
    result = stream_transcribe(
        model, audio, args.chunk_ms, device=device, verbose=not args.quiet
    )

    # Summary
    print(f"\n{'='*60}")
    print(f"Final text: {result.text}")
    print(f"{'='*60}")
    print(f"Chunks processed: {result.num_chunks}")
    print(f"Total time: {result.total_time:.3f}s")
    avg_ms = np.mean(result.chunk_latencies) * 1000
    max_ms = max(result.chunk_latencies) * 1000
    min_ms = min(result.chunk_latencies) * 1000
    print(f"Chunk latency — avg: {avg_ms:.1f}ms, min: {min_ms:.1f}ms, max: {max_ms:.1f}ms")

    if result.vram_peak_gb is not None:
        vram_current = torch.cuda.memory_allocated() / 1024**3
        print(f"VRAM — current: {vram_current:.2f} GB, peak: {result.vram_peak_gb:.2f} GB")


if __name__ == "__main__":
    main()
