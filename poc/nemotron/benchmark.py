"""Benchmark Nemotron Speech across chunk sizes and modes.

Runs:
1. Batch transcription (reference)
2. Streaming at 80ms, 160ms, 560ms, 1120ms chunks

Reports a table with: latency, VRAM, and transcript similarity vs batch.

Usage:
    python benchmark.py samples/test.wav
    python benchmark.py samples/test.wav --skip-batch
    python benchmark.py samples/test.wav --chunk-sizes 160 560
"""

from __future__ import annotations

import argparse
import tempfile
import time

import numpy as np
import soundfile as sf
import torch
import nemo.collections.asr as nemo_asr
from tabulate import tabulate

from transcribe_streaming import (
    CHUNK_CONFIGS,
    SAMPLE_RATE,
    StreamResult,
    configure_streaming,
    load_audio,
    stream_transcribe,
)


def word_overlap_ratio(reference: str, hypothesis: str) -> float:
    """Compute word-level overlap ratio between two strings.

    Returns the fraction of reference words present in the hypothesis.
    This is a simple similarity metric, not a proper WER calculation.
    """
    ref_words = set(reference.lower().split())
    hyp_words = set(hypothesis.lower().split())
    if not ref_words:
        return 1.0 if not hyp_words else 0.0
    return len(ref_words & hyp_words) / len(ref_words)


def ensure_16khz_mono(audio_file: str) -> str:
    """Return a path to a 16kHz mono WAV, converting if needed."""
    audio, sr = sf.read(audio_file, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    needs_convert = sr != 16000
    if needs_convert:
        import torchaudio

        audio_t = torch.tensor(audio).unsqueeze(0)
        audio = (
            torchaudio.transforms.Resample(sr, 16000)(audio_t).squeeze(0).numpy()
        )
    if needs_convert or audio.ndim != 1:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        sf.write(tmp.name, audio, 16000, subtype="PCM_16")
        return tmp.name
    return audio_file


def run_batch(
    model: nemo_asr.models.ASRModel,
    audio_file: str,
    device: str,
) -> tuple[str, float, float | None]:
    """Run batch transcription. Returns (text, time_seconds, vram_peak_gb)."""
    wav_path = ensure_16khz_mono(audio_file)

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    t0 = time.perf_counter()
    output = model.transcribe([wav_path])
    elapsed = time.perf_counter() - t0

    # Extract text — RNNT models return Hypothesis objects with .text
    if isinstance(output, list):
        item = output[0] if output else ""
    elif isinstance(output, tuple):
        item = output[0][0] if output[0] else ""
    else:
        item = output

    text = getattr(item, "text", str(item)) if item else ""

    vram: float | None = None
    if device == "cuda":
        vram = torch.cuda.max_memory_allocated() / 1024**3

    return text, elapsed, vram


def run_streaming(
    model: nemo_asr.models.ASRModel,
    audio: np.ndarray,
    chunk_ms: int,
    device: str,
) -> StreamResult:
    """Run streaming transcription at a given chunk size."""
    configure_streaming(model, chunk_ms)

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    return stream_transcribe(
        model, audio, chunk_ms, device=device, verbose=False
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark Nemotron Speech: streaming vs batch"
    )
    parser.add_argument("audio_file", help="Path to WAV file (16kHz mono)")
    parser.add_argument(
        "--model",
        default="nvidia/nemotron-speech-streaming-en-0.6b",
        help="Model name or path (default: %(default)s)",
    )
    parser.add_argument(
        "--chunk-sizes",
        type=int,
        nargs="+",
        default=sorted(CHUNK_CONFIGS.keys()),
        help=f"Chunk sizes to test (default: {sorted(CHUNK_CONFIGS.keys())})",
    )
    parser.add_argument(
        "--skip-batch",
        action="store_true",
        help="Skip batch transcription",
    )
    parser.add_argument(
        "--warmup",
        action="store_true",
        help="Run one warmup pass before benchmarking (reduces first-run overhead)",
    )
    args = parser.parse_args()

    # Validate chunk sizes
    for cs in args.chunk_sizes:
        if cs not in CHUNK_CONFIGS:
            parser.error(
                f"Unsupported chunk size: {cs}ms. "
                f"Supported: {sorted(CHUNK_CONFIGS.keys())}"
            )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")
    if device == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        vram_total = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"VRAM total: {vram_total:.1f} GB")
    else:
        print("WARNING: Running on CPU — expect slow results.")
    print()

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
    print()

    # Load audio
    audio = load_audio(args.audio_file)
    audio_duration = len(audio) / SAMPLE_RATE
    print(f"Audio: {args.audio_file} ({audio_duration:.2f}s)")
    print()

    # Optional warmup
    if args.warmup:
        print("Warmup pass (560ms streaming)...")
        configure_streaming(model, 560)
        stream_transcribe(model, audio, 560, device=device, verbose=False)
        print("Warmup complete.\n")

    # --- Batch ---
    batch_text: str | None = None
    batch_row: dict | None = None

    if not args.skip_batch:
        print("Running batch transcription...")
        batch_text, batch_time, batch_vram = run_batch(
            model, args.audio_file, device
        )
        batch_row = {
            "Mode": "batch",
            "Total Time": f"{batch_time:.3f}s",
            "Avg Chunk": "N/A",
            "Min Chunk": "N/A",
            "Max Chunk": "N/A",
            "Peak VRAM": f"{batch_vram:.2f} GB" if batch_vram else "N/A",
            "Match": "(reference)",
        }
        print(f"  Text: {batch_text}")
        print()

    # --- Streaming at each chunk size ---
    stream_rows: list[dict] = []

    for chunk_ms in sorted(args.chunk_sizes):
        print(f"Running streaming @ {chunk_ms}ms...")
        result = run_streaming(model, audio, chunk_ms, device)

        match_str = "N/A"
        if batch_text is not None:
            ratio = word_overlap_ratio(batch_text, result.text)
            match_str = f"{ratio:.0%}"

        avg_ms = np.mean(result.chunk_latencies) * 1000
        min_ms = min(result.chunk_latencies) * 1000
        max_ms = max(result.chunk_latencies) * 1000

        stream_rows.append(
            {
                "Mode": f"{chunk_ms}ms",
                "Total Time": f"{result.total_time:.3f}s",
                "Avg Chunk": f"{avg_ms:.1f}ms",
                "Min Chunk": f"{min_ms:.1f}ms",
                "Max Chunk": f"{max_ms:.1f}ms",
                "Peak VRAM": (
                    f"{result.vram_peak_gb:.2f} GB"
                    if result.vram_peak_gb
                    else "N/A"
                ),
                "Match": match_str,
            }
        )
        print(f"  Text: {result.text}")
        print()

    # --- Report ---
    rows = []
    if batch_row:
        rows.append(batch_row)
    rows.extend(stream_rows)

    print("=" * 70)
    print("BENCHMARK RESULTS")
    print(f"Audio: {args.audio_file} ({audio_duration:.2f}s)")
    print(f"Model: {args.model}")
    print("=" * 70)
    print()
    print(
        tabulate(
            rows,
            headers="keys",
            tablefmt="simple",
            stralign="right",
        )
    )
    print()

    # VRAM leak check
    if device == "cuda":
        vram_after = torch.cuda.memory_allocated() / 1024**3
        print(f"VRAM after all runs: {vram_after:.2f} GB (model baseline: {vram_model:.2f} GB)")
        delta = vram_after - vram_model
        if delta > 0.1:
            print(f"WARNING: VRAM increased by {delta:.2f} GB — possible memory leak")
        else:
            print("No VRAM leak detected.")


if __name__ == "__main__":
    main()
