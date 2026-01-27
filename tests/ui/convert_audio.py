"""Helper script to convert/resample audio files to the required format.

Usage:
    uv run -m tests.ui.convert_audio input.wav output.wav

Target format: 16kHz, 16-bit mono PCM
"""

import argparse
import sys
import wave
from pathlib import Path

import numpy as np

from tests.ui.client.audio import load_wav_file, resample_audio, SAMPLE_RATE


def convert_audio(input_path: Path, output_path: Path) -> None:
    """Convert audio file to 16kHz 16-bit mono PCM.

    Args:
        input_path: Source audio file
        output_path: Destination WAV file
    """
    # Load source audio
    samples, src_rate = load_wav_file(str(input_path))
    print(f"Loaded: {len(samples)} samples at {src_rate}Hz")

    # Resample if needed
    if src_rate != SAMPLE_RATE:
        samples = resample_audio(samples, src_rate, SAMPLE_RATE)
        print(f"Resampled to: {len(samples)} samples at {SAMPLE_RATE}Hz")

    # Write output
    with wave.open(str(output_path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # 16-bit
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(samples.tobytes())

    duration = len(samples) / SAMPLE_RATE
    print(f"Written: {output_path} ({duration:.2f}s)")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert audio to 16kHz 16-bit mono PCM",
    )
    parser.add_argument("input", type=Path, help="Input audio file")
    parser.add_argument("output", type=Path, help="Output WAV file")

    args = parser.parse_args()

    if not args.input.exists():
        print(f"Error: Input file not found: {args.input}", file=sys.stderr)
        return 1

    try:
        convert_audio(args.input, args.output)
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
