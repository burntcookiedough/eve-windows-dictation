# Nemotron vs Faster-Whisper Benchmark Report

**Date:** 2026-02-12
**Hardware:** NVIDIA RTX 4070 Ti SUPER (16 GB VRAM), Windows 11, WSL2
**Test audio:** 47.3 seconds of clear English narration (16kHz mono)

---

## Executive Summary

Nemotron Speech delivers **true streaming** with constant ~44ms per-chunk latency regardless of audio length. Our current faster-whisper setup re-transcribes the entire audio buffer each cycle, causing latency to grow from ~174ms to over 1000ms as audio accumulates. For a 5-minute dictation, Whisper would take 3-4 seconds per update while Nemotron stays at 44ms.

The trade-off: Nemotron streaming has slightly lower word accuracy (90% vs 100% match against batch) and uses more VRAM (~9.6 GB vs ~5.8 GB). Batch mode accuracy for both is excellent.

**Recommendation:** Use 160ms chunks for live transcription — fastest text updates AND best streaming quality.

---

## Head-to-Head Comparison

### Batch Transcription (Full File, One Shot)

| Metric | Faster-Whisper | Nemotron | Winner |
|--------|---------------|----------|--------|
| **Model** | large-v3-turbo | nemotron-speech-streaming-en-0.6b | — |
| **Parameters** | ~809M | ~600M | Nemotron |
| **Time** | 1.324s | 0.507s | **Nemotron (2.6x faster)** |
| **RTF** | 0.028 (36x RT) | 0.011 (93x RT) | **Nemotron** |
| **Model load** | 5.0s | 7.8s | Whisper |
| **VRAM (nvidia-smi)** | ~5.8 GB | ~9.6 GB | **Whisper** |
| **Confidence** | 0.95 | N/A (RNNT) | — |
| **Text quality** | Near-perfect | Near-perfect | Tie |

Both produce excellent batch transcription. Nemotron is 2.6x faster but uses 65% more VRAM (mostly NeMo framework overhead).

### Live Streaming Transcription

This is where the architectures fundamentally diverge.

| Metric | Whisper (simulated) | Nemotron 160ms | Nemotron 560ms | Nemotron 1120ms |
|--------|-------------------|----------------|----------------|-----------------|
| **Architecture** | Re-transcribe full buffer | Process new chunk only | Process new chunk only | Process new chunk only |
| **Update frequency** | Every 250ms | Every 160ms | Every 560ms | Every 1120ms |
| **Avg cycle latency** | 602ms | **44ms** | **46ms** | **47ms** |
| **Latency at 5s audio** | ~210ms | 44ms | 46ms | 47ms |
| **Latency at 20s audio** | ~500ms | 44ms | 46ms | 47ms |
| **Latency at 45s audio** | ~1060ms | 44ms | 46ms | 47ms |
| **Latency growth** | **6.1x** (174ms → 1058ms) | **None** | **None** | **None** |
| **Total GPU time** | 113.7s | 17.6s | 5.3s | 2.7s |
| **Word match vs batch** | 100% | 90% | 77% | 85% |
| **Peak VRAM** | ~5.9 GB | ~9.6 GB | ~9.6 GB | ~9.6 GB |

### The Critical Difference: Latency Scaling

```
Whisper "streaming" latency vs audio length:

  Audio length:  5s    10s    20s    30s    45s    60s    120s   300s
  Cycle time:   210ms  300ms  500ms  700ms  1060ms ~1400ms ~2800ms ~7000ms
                                                    (estimated)  (estimated)

Nemotron streaming latency vs audio length:

  Audio length:  5s    10s    20s    30s    45s    60s    120s   300s
  Chunk time:    44ms   44ms   44ms   44ms   44ms   44ms   44ms   44ms
```

Whisper's latency grows linearly because each cycle re-transcribes all accumulated audio. Nemotron only processes the newest chunk, so latency is constant. For dictation sessions over ~30 seconds, this becomes very noticeable to the user.

### GPU Utilization

For the 47.3s test clip:

- **Whisper simulated streaming**: 113.7s of GPU compute (2.4x the audio length!)
- **Nemotron 160ms streaming**: 17.6s of GPU compute (0.37x the audio length)
- **Nemotron 560ms streaming**: 5.3s of GPU compute (0.11x the audio length)

Whisper hammers the GPU continuously because it re-processes everything. Nemotron leaves the GPU mostly idle between chunks.

---

## Detailed Transcription Quality

### Reference Text (ground truth)
> Have you ever wondered how difficult it is for technology to interpret human speech? It is a fascinating process that turns invisible sound waves into digital text. Imagine standing in a busy coffee shop in Berlin. The background clatter of porcelain cups and low murmurs make it hard to hear, yet our brains filter the noise effortlessly. Machines are slowly learning to do the same thing. However, they still struggle to differentiate between words like 'right', 'write', and 'wright' without context clues. When you speak clearly, at a moderate pace, you help the software bridge that gap. So, take a deep breath, enunciate your vowels, and let's see if every syllable is captured correctly. This is the end of the narrative sample.

### Whisper Batch
> ...turns invisible sound waves into digital text. Imagine standing in a busy coffee shop in Berlin. The background clatter of porcelain cups and low murmurs make it hard to hear, yet our brains filter the noise effortlessly...words like **write, write, and write** without context clues...

Nearly perfect. Only notable issue: homophones "right/write/wright" all rendered as "write" (expected — no context to differentiate).

### Nemotron Batch
> ...words like **right, right, and right** without context clues...

Also nearly perfect. Same homophone issue, different rendering choice ("right" vs "write").

### Nemotron Streaming (160ms) — Best Streaming Quality
> ...turns invisible sound waves into digital text. Imagine standing **a** busy coffee shop in Berlin. The background clatter of porcelain cups and low murmurs make it hard to hear **our brains foot to** the noise effortlessly...

Minor artifacts: dropped "in", "foot to" instead of "filter", "every slow" instead of "every syllable". Still highly intelligible. 90% word overlap with batch.

### Nemotron Streaming (1120ms) — Larger Chunks
> ...turns invisible sound**s**. Imagine standing in a busy coffee shop...they still struggle to differentiate between **work**...let's see if **everyone** is captured...

Larger chunks produce different errors: truncated phrases, word substitutions. 85% word overlap.

---

## VRAM Analysis

| State | Whisper (CTranslate2) | Nemotron (NeMo/PyTorch) |
|-------|----------------------|------------------------|
| Before model load | ~0.4 GB | ~4.5 GB (PyTorch+NeMo runtime) |
| After model load | ~5.8 GB | ~9.6 GB |
| During streaming inference | ~5.9 GB | ~9.6 GB |
| **Net model size** | **~5.4 GB** | **~5.1 GB** |

The raw model sizes are similar (~5 GB). The difference is runtime overhead: CTranslate2 is a lightweight C++ inference runtime, while NeMo pulls in the full PyTorch stack plus its own framework. On a 16 GB GPU this leaves:

- **Whisper**: ~10 GB free for other tasks
- **Nemotron**: ~6.4 GB free for other tasks

Both fit comfortably on a 16 GB GPU. Neither would fit on 8 GB with current configurations.

---

## Strengths and Weaknesses

### Faster-Whisper (current)

**Strengths:**
- Lower VRAM footprint (~5.8 GB)
- Perfect quality in simulated streaming (re-processing gives self-correction)
- Lightweight runtime (CTranslate2, pip install, ~100 MB)
- 25+ language support
- Well-understood, battle-tested in production

**Weaknesses:**
- Latency scales linearly with audio length (unusable for long sessions without windowing)
- Massive GPU waste (re-processes entire buffer every cycle)
- No true streaming — it's a batch model pretending to stream
- VAD adds latency (must wait for silence to confirm words)

### Nemotron Speech (candidate)

**Strengths:**
- True streaming with constant ~44ms latency — feels instant
- O(1) compute per update regardless of session length
- 2.6x faster batch throughput
- Built for cache-aware incremental decoding
- Smaller model parameter count (600M vs 809M)

**Weaknesses:**
- Higher total VRAM (~9.6 GB due to NeMo framework)
- Streaming word accuracy lower than Whisper re-processing (~90% vs 100%)
- English only (currently)
- Heavy dependency chain (NeMo toolkit, ~2 GB install)
- 80ms chunks don't work (minimum 160ms due to 8x subsampling)
- Newer, less production-tested

---

## Why 160ms is the Best Chunk Size

Looking at the numbers again with the right lens:

| Chunk Size | Update Frequency | Per-Chunk Latency | Word Match | User Perception |
|-----------|-----------------|-------------------|------------|-----------------|
| **160ms** | **Every 160ms** | **44ms** | **90%** | **Near-instant, highest quality** |
| 560ms | Every 560ms | 46ms | 77% | Good, slight delay |
| 1120ms | Every 1120ms | 47ms | 85% | Noticeable delay between updates |

For a live transcription app:
1. **Update frequency matters most** — users want to see text appear as they speak. 160ms means text updates 6x per second. 560ms means less than 2x per second.
2. **Per-chunk latency is nearly identical** — the GPU doesn't care about chunk size, all take ~44-47ms.
3. **Quality is best at 160ms** — more frequent encoder updates give better contextual decoding. The 560ms quality dip (77%) is likely because chunk boundaries fall in the middle of words more often.

The "total time" metric (17.6s for 160ms vs 2.7s for 1120ms) is irrelevant for live use — you're processing chunks as audio arrives in real-time, not back-to-back.

---

## Projected Performance for Longer Sessions

| Session Length | Whisper Cycle Latency (est.) | Nemotron Chunk Latency |
|---------------|-----------------------------|-----------------------|
| 30 seconds | ~700ms | 44ms |
| 1 minute | ~1.4s | 44ms |
| 2 minutes | ~2.8s | 44ms |
| 5 minutes | ~7.0s | 44ms |
| 10 minutes | ~14s | 44ms |

At 5 minutes, Whisper would take 7 seconds to process each update cycle — the user would experience text appearing in slow, jarring bursts. Nemotron stays smooth throughout.

**Note:** Murmur could mitigate Whisper's scaling with a sliding window (only re-transcribe the last N seconds), but that sacrifices the self-correction benefit and adds complexity. Nemotron solves this architecturally.

---

## Conclusions

1. **For live streaming transcription, Nemotron is fundamentally better** — constant latency is a qualitative improvement, not just a quantitative one.
2. **For batch/offline transcription, both are excellent** — Nemotron is faster but both produce near-perfect text.
3. **160ms chunks are optimal** for live use — best quality and most responsive feel.
4. **VRAM is the main cost** — Nemotron + NeMo needs ~9.6 GB vs Whisper's ~5.8 GB. Both fit on 16 GB.
5. **English-only is a real limitation** — if multilingual support is needed, Whisper remains necessary.
6. **Dual-engine architecture is the right path** — offer both, let the user choose based on their needs.
