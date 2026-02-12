# Nemotron Speech PoC

Standalone proof-of-concept for NVIDIA Nemotron Speech (`nvidia/nemotron-speech-streaming-en-0.6b`) cache-aware streaming transcription.

**Goal:** Validate that the model loads, streams correctly, and meets latency/VRAM targets on our hardware (RTX 4070 Ti SUPER, 16 GB VRAM) before integrating into Murmur's server.

## Prerequisites

- Windows with NVIDIA GPU (CUDA 12.x)
- Python >= 3.11
- [uv](https://docs.astral.sh/uv/) installed
- ~5 GB free disk space (model + dependencies)

## Setup

All commands run on Windows via PowerShell. From WSL, prefix with:
```bash
/mnt/c/Program\ Files/PowerShell/7/pwsh.exe -NoProfile -Command "<command>"
```

### Install dependencies

```powershell
cd C:\Users\raikr\Documents\projs\murmur\nemotron\poc\nemotron
uv sync
```

> **Note:** First run downloads the NeMo toolkit + PyTorch with CUDA support (~3-4 GB). The Nemotron model checkpoint (~2.5 GB) is downloaded on first use.

### Get a test audio file

Place a 16kHz mono WAV file in `samples/`. You can download a LibriSpeech sample:

```powershell
# Download a LibriSpeech test-clean sample (~30s of speech)
Invoke-WebRequest -Uri "https://www.openslr.org/resources/12/test-clean.tar.gz" -OutFile test-clean.tar.gz
# Or use any 16kHz mono WAV file you have
```

For quick testing, any short WAV file at 16kHz mono will work. If your file is a different sample rate, the scripts will resample it automatically.

## Usage

### Batch transcription (simplest test)

```powershell
uv run python transcribe_batch.py samples/test.wav
```

Validates that the model loads and produces correct output.

### Streaming transcription

```powershell
# Default: 560ms chunks (balanced latency/accuracy)
uv run python transcribe_streaming.py samples/test.wav

# Low-latency: 80ms chunks
uv run python transcribe_streaming.py samples/test.wav --chunk-ms 80

# High-accuracy: 1120ms chunks
uv run python transcribe_streaming.py samples/test.wav --chunk-ms 1120

# Quiet mode (no per-chunk output, just summary)
uv run python transcribe_streaming.py samples/test.wav --quiet
```

Shows partial text after each chunk, simulating live transcription.

### Full benchmark

```powershell
# Run all chunk sizes + batch mode
uv run python benchmark.py samples/test.wav

# With warmup pass (reduces first-run JIT overhead)
uv run python benchmark.py samples/test.wav --warmup

# Test specific chunk sizes only
uv run python benchmark.py samples/test.wav --chunk-sizes 160 560
```

Outputs a comparison table:

```
Mode     Total Time  Avg Chunk  Min Chunk  Max Chunk  Peak VRAM    Match
batch        0.800s        N/A        N/A        N/A   2.40 GB  (reference)
80ms         1.200s     38.0ms     35.0ms     42.0ms   2.10 GB        98%
160ms        1.100s     41.0ms     38.0ms     45.0ms   2.10 GB        99%
560ms        1.000s     45.0ms     42.0ms     50.0ms   2.20 GB        99%
1120ms       0.900s     52.0ms     48.0ms     58.0ms   2.30 GB       100%
```

## Chunk Size Guide

| Chunk Size | Latency   | Accuracy | Best For                        |
|------------|-----------|----------|---------------------------------|
| 80ms       | Ultra-low | Lower    | Live captions, real-time feedback |
| 160ms      | Very low  | Good     | Interactive voice apps          |
| **560ms**  | Low       | Better   | **Balanced (recommended for Murmur)** |
| 1120ms     | Moderate  | Best     | High-accuracy streaming         |

## What This Validates

- Model loads on RTX 4070 Ti SUPER without errors
- Cache-aware streaming produces text incrementally
- Per-chunk latency is in the ~40-60ms range
- VRAM stays under ~4 GB (model + cache + overhead)
- All chunk sizes produce reasonable transcriptions
- No VRAM leaks across chunks

## What This Does NOT Do

- Touch the real Murmur server code
- Implement the engine abstraction layer
- Do live microphone capture (WAV files only)
- Integrate with the WebSocket protocol

## Troubleshooting

**`torch.cuda.is_available()` returns False:**
Ensure you have CUDA-compatible PyTorch installed. The `pyproject.toml` is configured to pull CUDA 12.4 wheels. If you have a different CUDA version, edit the `extra-index-url` in `pyproject.toml`.

**Model download fails:**
The model is downloaded from NVIDIA NGC on first use. Ensure you have internet access and sufficient disk space (~2.5 GB for the checkpoint).

**Out of memory:**
The model needs ~2 GB VRAM. If you're running other GPU-intensive applications, close them first.
