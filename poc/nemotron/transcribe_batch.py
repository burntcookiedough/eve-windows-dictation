"""Batch transcription using Nemotron Speech.

Loads the full audio file and transcribes it in one shot.
Used as a reference baseline for streaming comparison.

Usage:
    python transcribe_batch.py samples/test.wav
    python transcribe_batch.py samples/test.wav --model nvidia/parakeet-tdt-0.6b-v3
"""

import argparse
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import nemo.collections.asr as nemo_asr


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch transcription with Nemotron Speech"
    )
    parser.add_argument("audio_file", help="Path to WAV file (16kHz mono)")
    parser.add_argument(
        "--model",
        default="nvidia/nemotron-speech-streaming-en-0.6b",
        help="Model name or path (default: %(default)s)",
    )
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")

    if device == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        torch.cuda.reset_peak_memory_stats()
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
        vram_after_load = torch.cuda.memory_allocated() / 1024**3
        print(f"VRAM after model load: {vram_after_load:.2f} GB")

    # Ensure audio is 16kHz mono WAV (NeMo expects this)
    audio_file = args.audio_file
    audio, sr = sf.read(audio_file, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    needs_temp = sr != 16000 or audio.ndim != 1
    if sr != 16000:
        import torchaudio
        audio_t = torch.tensor(audio).unsqueeze(0)
        audio = torchaudio.transforms.Resample(sr, 16000)(audio_t).squeeze(0).numpy()
        needs_temp = True
    if needs_temp:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        sf.write(tmp.name, audio, 16000, subtype="PCM_16")
        audio_file = tmp.name
        print(f"Converted to 16kHz mono: {len(audio)/16000:.2f}s")

    # Transcribe
    print(f"\nTranscribing: {args.audio_file}")
    t0 = time.perf_counter()
    output = model.transcribe([audio_file])
    transcribe_time = time.perf_counter() - t0

    # Extract text — model.transcribe() return type varies across NeMo versions.
    # RNNT models return Hypothesis objects with a .text attribute.
    if isinstance(output, list):
        item = output[0] if output else ""
    elif isinstance(output, tuple):
        item = output[0][0] if output[0] else ""
    else:
        item = output

    text = getattr(item, "text", str(item)) if item else ""

    print(f"\n{'='*60}")
    print(f"Text: {text}")
    print(f"{'='*60}")
    print(f"Transcription time: {transcribe_time:.3f}s")

    if device == "cuda":
        vram_peak = torch.cuda.max_memory_allocated() / 1024**3
        print(f"Peak VRAM: {vram_peak:.2f} GB")


if __name__ == "__main__":
    main()
