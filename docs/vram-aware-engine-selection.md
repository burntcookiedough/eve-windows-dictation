# VRAM-Aware Engine Selection & Recording Limits

**Date:** 2026-02-16
**Status:** Design / Requirements
**Hardware context:** RTX 4070 Ti SUPER (16 GB), but targeting all consumer GPUs

---

## 1. Context & Motivation

Murmur supports two ASR engines — Nemotron Speech (NVIDIA's FastConformer RNNT, 600M params) and Faster-Whisper (CTranslate2 backend, large-v3-turbo, ~809M params). Both use GPU acceleration, but they have very different VRAM profiles.

Today, the engine is selected by a config setting (`engine: "nemotron" | "whisper"`), defaulting to Nemotron. If the user's GPU lacks sufficient VRAM, Nemotron will either crash at model load, run out of memory mid-transcription, or degrade performance due to CUDA memory pressure — with no warning or graceful handling.

**The need:** Murmur should detect the GPU's available VRAM at startup, make an informed engine selection, and communicate recording duration limits to the user — especially in production mode where the Electron app auto-starts the server and the user may not be watching logs.

---

## 2. How VRAM Is Used

### 2.1 Model Loading (Static)

Each engine has a base VRAM footprint just from loading the model into GPU memory:

| Engine | Model on disk | Observed VRAM at idle (nvidia-smi) | Notes |
|--------|-------------|-----------------------------------|-------|
| **Nemotron** | ~2.3 GB (.nemo) | **~5.0 GB** | NeMo framework adds substantial overhead (PyTorch, CUDA graphs, tokenizer, RNNT decoder) |
| **Whisper** | ~1.5 GB (CTranslate2 int8) | **~3.1 GB** | CTranslate2 manages its own memory pool outside PyTorch; int8 quantization reduces footprint significantly |

The gap between on-disk model size and runtime VRAM is due to framework overhead, CUDA context, kernel caches, and the CUDA caching allocator's initial reservations.

**Sources:**
- Nemotron model size: [nvidia/nemotron-speech-streaming-en-0.6b on HuggingFace](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)
- Whisper int8 VRAM: INT8 quantization reduces VRAM from 11.3 GB (float32) to ~3.1 GB ([faster-whisper README](https://github.com/SYSTRAN/faster-whisper); [benchmark on SimpliSmart](https://simplismart.ai/blog/deploy-whisper-v3-turbo-using-vox-box))
- Murmur benchmark observations: see [`docs/benchmark-report.md`](benchmark-report.md) — Whisper ~5.8 GB, Nemotron ~9.6 GB at peak during batch transcription of 47s audio

### 2.2 Transcription (Dynamic Growth)

Both engines use **full-buffer batch retranscription** — the entire accumulated audio is re-processed with each partial emission cycle (~250ms). This means VRAM usage grows with recording duration:

- **Mel spectrogram**: The audio is converted to 80-band mel spectrograms at 10ms stride (100 frames/second). A 60-second recording produces 6,000 frames.
- **Encoder activations**: FastConformer applies 8× convolutional downsampling, reducing to ~12.5 frames/second. With 24 encoder layers, intermediate activations scale linearly with audio length. The attention mechanism is "linearly scalable" — not quadratic — thanks to local attention with global tokens ([NVIDIA Research: Fast Conformer with Linearly Scalable Attention](https://research.nvidia.com/labs/conv-ai/blogs/2023/2023-06-07-fast-conformer/); [arXiv:2305.05084](https://arxiv.org/abs/2305.05084)).
- **RNNT decoder**: Processes the encoder output sequentially. Memory usage for the joint network and prediction network is proportional to output length (word count), not audio length — a smaller factor.
- **PyTorch caching allocator**: PyTorch does not return freed CUDA memory to the GPU driver. Instead it maintains a cache of memory blocks for reuse. As audio grows and tensors get progressively larger, the allocator requests new blocks but retains old ones, leading to steady VRAM growth even though active usage is lower ([PyTorch CUDA Caching Allocator guide](https://zdevito.github.io/2022/08/04/cuda-caching-allocator.html); [PyTorch CUDA semantics docs](https://docs.pytorch.org/docs/stable/notes/cuda.html)).
- **CUDA graphs**: NeMo's RNNT decoder uses CUDA graphs for inference optimization. These capture GPU operations and hold references to GPU memory. Calling `torch.cuda.empty_cache()` without first disabling CUDA graphs causes a native crash ([NeMo Issue #14727](https://github.com/NVIDIA-NeMo/NeMo/issues/14727)). Murmur handles this with `model.disable_cuda_graphs()` → `empty_cache()` → `model.maybe_enable_cuda_graphs()` between sessions.

### 2.3 Between Sessions (VRAM Reclamation)

With the CUDA graphs workaround in place, VRAM can be reclaimed between recording sessions via `torch.cuda.empty_cache()`. This means VRAM resets to near-baseline between recordings — the user's maximum VRAM budget applies per-recording, not cumulative across recordings.

**Important caveat:** `gc.collect()` must NOT be called between `model.transcribe()` invocations — it destroys NeMo internal objects and causes native crashes. Only `empty_cache()` (with CUDA graphs temporarily disabled) is safe.

### 2.4 Whisper's Memory Behavior

Faster-Whisper uses CTranslate2, which manages GPU memory outside PyTorch's CUDA caching allocator ([CTranslate2 docs](https://github.com/OpenNMT/CTranslate2)). This means:
- VRAM is managed more efficiently (no caching allocator fragmentation)
- `torch.cuda.empty_cache()` has no effect on CTranslate2 memory
- Memory still grows with audio length (re-transcription), but the growth rate is lower
- Peak VRAM observed: ~5.8–5.9 GB for 47s audio vs Nemotron's ~9.6 GB

---

## 3. Observed VRAM Growth Rate

From our testing on an RTX 4070 Ti SUPER (16 GB):

| Duration | Nemotron VRAM (approx) | Notes |
|----------|----------------------|-------|
| Idle (model loaded) | ~5.0 GB | Base footprint |
| ~10s recording | ~5.5 GB | First transcription cycles |
| ~30s recording | ~7.0–7.5 GB | Steady growth |
| ~47s recording | ~9.6 GB | Peak from benchmark |

This gives a rough growth rate of approximately **100 MB per second of audio** for Nemotron (varies with content, speech density, and allocator behavior).

For Whisper, the growth is lower — from ~3.1 GB idle to ~5.8 GB at 47s, suggesting approximately **55–60 MB per second**.

> **Note:** These are empirical observations from a single hardware configuration. The growth rate depends on GPU architecture, CUDA version, PyTorch version, and NeMo version. They should be treated as rough approximations, not precise specifications. A more robust approach would be to measure actual VRAM delta after the first transcription and use that to calibrate the estimate at runtime.

---

## 4. VRAM Budget by GPU

Using the Nemotron growth rate (~100 MB/s) and base load (~5 GB), here's the estimated maximum single-recording duration across common consumer GPUs:

| GPU | VRAM | Available for growth | Est. max recording | Suitable? |
|-----|------|---------------------|-------------------|-----------|
| RTX 4060 / 3060 | 8 GB | ~3 GB | ~30s | Marginal |
| RTX 4060 Ti 8GB | 8 GB | ~3 GB | ~30s | Marginal |
| RTX 3070 / 4070 | 8–12 GB | 3–7 GB | 30s–70s | OK for short dictation |
| RTX 3080 / 4070 Super | 12 GB | ~7 GB | ~70s | Good |
| **RTX 4070 Ti SUPER** | **16 GB** | **~11 GB** | **~110s (~1.8 min)** | **Good** |
| RTX 4080 / 5070 Ti / 5080 | 16 GB | ~11 GB | ~110s | Good |
| RTX 4090 | 24 GB | ~19 GB | ~190s (~3.2 min) | Excellent |
| RTX 5090 | 32 GB | ~27 GB | ~270s (~4.5 min) | Excellent |

For Whisper (base ~3.1 GB, growth ~57 MB/s):

| GPU | VRAM | Available | Est. max recording |
|-----|------|-----------|-------------------|
| 8 GB | ~5 GB | ~88s | Good |
| 12 GB | ~9 GB | ~158s | Excellent |
| 16 GB | ~13 GB | ~228s | Excellent |

**GPU VRAM reference:** [GeForce RTX 40 Series — Wikipedia](https://en.wikipedia.org/wiki/GeForce_RTX_40_series); [GeForce RTX 50 Series — Wikipedia](https://en.wikipedia.org/wiki/GeForce_RTX_50_series); [NVIDIA RTX 40 Series page](https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/)

---

## 5. Requirements & Constraints

### 5.1 VRAM Detection

- Use `torch.cuda.get_device_properties(device).total_memory` to detect total GPU VRAM ([PyTorch docs](https://docs.pytorch.org/docs/stable/notes/cuda.html))
- Must handle: no GPU present, multiple GPUs (use the one selected by config), CUDA not available
- Detection should happen early — before engine loading, ideally in the factory

### 5.2 Engine Auto-Selection

When the configured engine is Nemotron but VRAM is insufficient:

- **Minimum threshold for Nemotron**: Below ~8 GB total VRAM, the model may load but leaves essentially no room for transcription (~30s max). This should trigger a fallback.
- **Fallback behavior**: If Whisper is available, auto-switch to Whisper with a clear log message explaining why. If neither engine fits, error out with guidance.
- **User override**: If the user explicitly chose Nemotron (not just the default), respect the choice but log a warning about expected limitations.
- **Production vs dev mode**: In production mode (Electron auto-starts server), auto-fallback is more important since the user isn't watching the terminal. In dev mode, warnings may be sufficient.

### 5.3 Recording Duration Estimate

- Calculate and expose estimated max recording duration based on: total VRAM, engine base load, empirical growth rate
- This is an **approximation** — frame it as "approximately X minutes" not a hard limit
- Display in: startup log, `EngineInfo` (REST API + settings UI), health endpoint
- The estimate should recalculate if the engine changes (swap from Nemotron to Whisper gives different limits)

### 5.4 What Happens When VRAM Runs Out

Currently, if VRAM is exhausted during a recording:
- PyTorch raises `torch.cuda.OutOfMemoryError` (catchable in Python)
- The transcription call fails but the session continues
- The user gets no transcription for that cycle, then likely for all subsequent cycles

What should happen:
- Catch the OOM error gracefully
- Return the last successful transcription as the final result
- Log a clear warning about VRAM exhaustion
- Potentially notify the client via the WebSocket protocol so the UI can inform the user

### 5.5 Constraints We Know About

- **CUDA graphs must be disabled before `empty_cache()`** — NeMo's RNNT decoder uses CUDA graphs that crash if their memory is freed ([NeMo #14727](https://github.com/NVIDIA-NeMo/NeMo/issues/14727))
- **`gc.collect()` must never be called between transcription calls** — destroys NeMo internal objects, causes native crash
- **CTranslate2 memory is invisible to PyTorch** — `torch.cuda.memory_allocated()` won't show Whisper's usage; for Whisper, total VRAM detection should use nvidia-smi or `pynvml`, but this adds complexity
- **Growth rate is approximate** — it depends on speech density (more words = more decoder work), audio characteristics, and allocator fragmentation. A hardcoded constant is a starting point; runtime measurement would be more accurate but adds complexity
- **Linear attention scaling** — FastConformer's attention is designed to scale linearly with sequence length ([arXiv:2305.05084](https://arxiv.org/abs/2305.05084)), but the RNNT decoder and caching allocator behavior add non-linear factors
- **Shared VRAM** — On consumer GPUs, VRAM is shared with display output, other apps, and the OS compositor. The actual available VRAM is less than the spec sheet number. Using `torch.cuda.mem_get_info()` (which returns free + total) might be more accurate than `total_memory` alone, but free memory fluctuates.

---

## 6. Design Considerations

### 6.1 Where to Put the VRAM Check

**Option A — In the factory (`factory.py`)**
The factory already has engine fallback logic in `load_initial_engine()`. Adding a VRAM pre-check here keeps all engine selection logic centralized. The factory would check VRAM before creating the engine, not after.

**Option B — In the engine constructor**
The engine itself checks VRAM during init and raises a specific exception (e.g., `InsufficientVRAMError`) that the factory catches and handles. This keeps VRAM knowledge in the engine that knows its own requirements.

**Option C — Separate detection step**
A standalone `detect_gpu_capabilities()` function that returns GPU info (VRAM, compute capability, name) and is called before any engine loading. Results are stored on the engine manager and available to all consumers.

Each approach has trade-offs around separation of concerns and import timing (torch must be importable to check VRAM, which pulls in CUDA).

### 6.2 How to Express the Estimate to Users

The estimate appears in multiple places with different audiences:

- **Server log** (developer): `"Nemotron loaded (RTX 4070 Ti SUPER, 16 GB VRAM) — est. max recording ~1.8 min"`
- **REST API** (`/settings`, `/health`): Include in `EngineInfo` as a numeric field (`estimated_max_duration_s: 110`) so the UI can format it
- **Settings UI**: Display near the engine selector, e.g. _"Nemotron Speech — est. max ~2 min per recording (16 GB GPU)"_
- **During recording** (stretch goal): If audio duration approaches the estimated limit, warn the user through the WebSocket protocol

### 6.3 Hardcoded Constants vs Runtime Measurement

**Hardcoded approach:**
- Base VRAM and growth rate per engine as constants
- Simple, predictable, works without any runtime measurement
- Risk: may be inaccurate on different hardware/driver/NeMo versions

**Runtime measurement approach:**
- After the first transcription completes, measure VRAM delta and calibrate the growth rate
- More accurate, adapts to the actual environment
- More complex, and the first estimate (before any transcription) still needs a fallback

A **hybrid** approach works well: start with hardcoded estimates, optionally refine after first transcription.

### 6.4 EngineInfo Extension

The `EngineInfo` dataclass currently has:
```python
@dataclass(frozen=True)
class EngineInfo:
    id: str
    name: str
    model: str
    supports_hotwords: bool
    languages: list[str]
    model_size_gb: float
```

Potential additions:
```python
    gpu_name: str | None           # "NVIDIA RTX 4070 Ti SUPER"
    gpu_vram_gb: float | None      # 16.0
    estimated_max_duration_s: int | None  # 110
```

The frontend `EngineInfo` TypeScript type would need matching fields.

---

## 7. References

- [NeMo Issue #14727 — ASR batch transcription crash with `torch.cuda.empty_cache()`](https://github.com/NVIDIA-NeMo/NeMo/issues/14727)
- [NeMo Issue #5755 — GPU memory leak in `asr_model.transcribe()`](https://github.com/NVIDIA/NeMo/issues/5755)
- [nvidia/nemotron-speech-streaming-en-0.6b — Model Card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)
- [Scaling Real-Time Voice Agents with Cache-Aware Streaming ASR](https://huggingface.co/blog/nvidia/nemotron-speech-asr-scaling-voice-agents)
- [Fast Conformer with Linearly Scalable Attention — NVIDIA Research](https://research.nvidia.com/labs/conv-ai/blogs/2023/2023-06-07-fast-conformer/)
- [Fast Conformer with Linearly Scalable Attention — arXiv:2305.05084](https://arxiv.org/abs/2305.05084)
- [PyTorch CUDA Caching Allocator — Zach DeVito](https://zdevito.github.io/2022/08/04/cuda-caching-allocator.html)
- [PyTorch CUDA semantics documentation](https://docs.pytorch.org/docs/stable/notes/cuda.html)
- [faster-whisper (CTranslate2 backend)](https://github.com/SYSTRAN/faster-whisper)
- [GeForce RTX 40 Series — Wikipedia](https://en.wikipedia.org/wiki/GeForce_RTX_40_series)
- [GeForce RTX 50 Series — Wikipedia](https://en.wikipedia.org/wiki/GeForce_RTX_50_series)
- Murmur benchmark report: [`docs/benchmark-report.md`](benchmark-report.md)
