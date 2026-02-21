"""Benchmark faster-whisper for comparison with Nemotron Speech.

Runs two modes on the same audio file:
1. Batch — one-shot transcription of the full file
2. Simulated streaming — re-transcribes growing buffer every 250ms,
   mimicking Murmur's current live transcription approach

Usage:
    python benchmark_whisper.py ../nemotron/samples/test.wav
    python benchmark_whisper.py ../nemotron/samples/test.wav --model large-v3-turbo
"""

from __future__ import annotations

import argparse
import time

import numpy as np
import soundfile as sf
import torch
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000


def load_audio(path: str) -> np.ndarray:
    """Load audio file as float32 mono at 16kHz."""
    audio, sr = sf.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        import torchaudio

        audio_t = torch.tensor(audio).unsqueeze(0)
        audio = (
            torchaudio.transforms.Resample(sr, SAMPLE_RATE)(audio_t)
            .squeeze(0)
            .numpy()
        )
    return audio


def word_overlap_ratio(reference: str, hypothesis: str) -> float:
    """Compute word-level overlap ratio between two strings."""
    ref_words = set(reference.lower().split())
    hyp_words = set(hypothesis.lower().split())
    if not ref_words:
        return 1.0 if not hyp_words else 0.0
    return len(ref_words & hyp_words) / len(ref_words)


def transcribe_batch(model: WhisperModel, audio: np.ndarray) -> tuple[str, float, float]:
    """Batch transcription. Returns (text, time_seconds, confidence)."""
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    t0 = time.perf_counter()
    segments, info = model.transcribe(
        audio,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    # Consume the generator to get full text
    text_parts = []
    total_prob = 0.0
    seg_count = 0
    for seg in segments:
        text_parts.append(seg.text.strip())
        total_prob += seg.avg_logprob
        seg_count += 1
    elapsed = time.perf_counter() - t0

    text = " ".join(text_parts)
    avg_confidence = 0.0
    if seg_count > 0:
        avg_log_prob = total_prob / seg_count
        avg_confidence = min(1.0, max(0.0, 1.0 + avg_log_prob / 2.0))

    return text, elapsed, avg_confidence


def simulated_streaming(
    model: WhisperModel,
    audio: np.ndarray,
    emission_interval: float = 0.25,
    *,
    verbose: bool = True,
) -> dict:
    """Simulate Murmur's streaming: re-transcribe entire buffer every interval.

    This simulates real-time audio arrival: audio accumulates at 1x speed,
    and every emission_interval we re-transcribe the full accumulated buffer.

    Returns dict with timing and quality metrics.
    """
    audio_duration = len(audio) / SAMPLE_RATE
    # How many samples arrive per emission interval
    samples_per_interval = int(emission_interval * SAMPLE_RATE)

    # Simulate real-time arrival
    cycle_latencies: list[float] = []
    cycle_audio_durations: list[float] = []
    last_text = ""
    text_updates: list[tuple[float, str]] = []  # (audio_time, text)
    total_inference_time = 0.0

    # Walk through audio in real-time-sized chunks
    buffer_end = 0
    cycle = 0

    while buffer_end < len(audio):
        # Accumulate the next interval of audio
        buffer_end = min(buffer_end + samples_per_interval, len(audio))
        current_audio_s = buffer_end / SAMPLE_RATE

        # Skip if less than 0.5s accumulated (matches server behavior)
        if current_audio_s < 0.5:
            continue

        # Re-transcribe the ENTIRE buffer
        buffer = audio[:buffer_end]
        t0 = time.perf_counter()
        segments, _ = model.transcribe(
            buffer,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        text = " ".join(seg.text.strip() for seg in segments)
        cycle_time = time.perf_counter() - t0

        cycle_latencies.append(cycle_time)
        cycle_audio_durations.append(current_audio_s)
        total_inference_time += cycle_time
        cycle += 1

        if text != last_text:
            text_updates.append((current_audio_s, text))
            if verbose:
                print(
                    f"  [{current_audio_s:6.2f}s] ({cycle_time * 1000:7.1f}ms) "
                    f"{text}"
                )
            last_text = text

    return {
        "text": last_text,
        "total_inference_time": total_inference_time,
        "cycle_count": cycle,
        "cycle_latencies": cycle_latencies,
        "cycle_audio_durations": cycle_audio_durations,
        "text_updates": text_updates,
        "audio_duration": audio_duration,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark faster-whisper (batch + simulated streaming)"
    )
    parser.add_argument("audio_file", help="Path to WAV file")
    parser.add_argument(
        "--model",
        default="large-v3-turbo",
        help="Whisper model name (default: %(default)s)",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "cuda"],
        help="Device (default: auto)",
    )
    parser.add_argument(
        "--compute-type",
        default="auto",
        help="Compute type (default: auto)",
    )
    parser.add_argument(
        "--emission-interval",
        type=float,
        default=0.25,
        help="Simulated streaming emission interval in seconds (default: 0.25)",
    )
    args = parser.parse_args()

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"

    print(f"Device: {device}")
    if device == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        vram_total = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"VRAM total: {vram_total:.1f} GB")
    print()

    # Load model
    print(f"Loading model: {args.model}")
    t0 = time.perf_counter()
    model = WhisperModel(args.model, device=device, compute_type=args.compute_type)
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

    # --- Batch ---
    print("=" * 70)
    print("BATCH TRANSCRIPTION")
    print("=" * 70)

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    batch_text, batch_time, batch_confidence = transcribe_batch(model, audio)

    batch_vram: float | None = None
    if device == "cuda":
        batch_vram = torch.cuda.max_memory_allocated() / 1024**3

    rtf_batch = batch_time / audio_duration
    print(f"Text: {batch_text}")
    print(f"Time: {batch_time:.3f}s (RTF: {rtf_batch:.4f}, {1/rtf_batch:.0f}x real-time)")
    print(f"Confidence: {batch_confidence:.2f}")
    if batch_vram is not None:
        print(f"Peak VRAM: {batch_vram:.2f} GB")
    print()

    # --- Simulated streaming ---
    print("=" * 70)
    print(f"SIMULATED STREAMING (re-transcribe every {args.emission_interval}s)")
    print("=" * 70)
    print()

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    stream = simulated_streaming(
        model, audio, emission_interval=args.emission_interval, verbose=True
    )

    stream_vram: float | None = None
    if device == "cuda":
        stream_vram = torch.cuda.max_memory_allocated() / 1024**3

    print()
    avg_latency = np.mean(stream["cycle_latencies"]) * 1000
    min_latency = min(stream["cycle_latencies"]) * 1000
    max_latency = max(stream["cycle_latencies"]) * 1000

    # Latency growth: compare first 10% vs last 10% of cycles
    n = len(stream["cycle_latencies"])
    early = stream["cycle_latencies"][: max(1, n // 10)]
    late = stream["cycle_latencies"][-max(1, n // 10) :]
    early_avg = np.mean(early) * 1000
    late_avg = np.mean(late) * 1000

    match_ratio = word_overlap_ratio(batch_text, stream["text"])

    print(f"Final text: {stream['text']}")
    print(f"Match vs batch: {match_ratio:.0%}")
    print(f"Total inference time: {stream['total_inference_time']:.1f}s")
    print(f"Cycles: {stream['cycle_count']}")
    print(f"Cycle latency — avg: {avg_latency:.1f}ms, min: {min_latency:.1f}ms, max: {max_latency:.1f}ms")
    print(f"Latency growth — early: {early_avg:.1f}ms, late: {late_avg:.1f}ms ({late_avg/early_avg:.1f}x)")
    if stream_vram is not None:
        print(f"Peak VRAM: {stream_vram:.2f} GB")

    # --- Summary ---
    print()
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"Model: {args.model} | Device: {device} | Audio: {audio_duration:.1f}s")
    print()
    print(f"  {'Mode':<25} {'Latency':>12} {'VRAM':>10} {'Quality':>10}")
    print(f"  {'-'*25} {'-'*12} {'-'*10} {'-'*10}")
    print(
        f"  {'Batch':<25} {f'{batch_time*1000:.0f}ms total':>12} "
        f"{f'{batch_vram:.2f} GB' if batch_vram else 'N/A':>10} "
        f"{'(reference)':>10}"
    )
    print(
        f"  {f'Streaming @{args.emission_interval}s':<25} "
        f"{f'{avg_latency:.0f}ms avg':>12} "
        f"{f'{stream_vram:.2f} GB' if stream_vram else 'N/A':>10} "
        f"{f'{match_ratio:.0%}':>10}"
    )
    print()
    print(f"  Streaming latency GROWS with buffer: {early_avg:.0f}ms -> {late_avg:.0f}ms")
    print(f"  Total GPU time for streaming: {stream['total_inference_time']:.1f}s "
          f"(vs {batch_time:.1f}s batch)")


if __name__ == "__main__":
    main()
