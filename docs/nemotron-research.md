# Nemotron Speech vs faster-whisper: Integration Research for Murmur

## Executive Summary

This document evaluates replacing Murmur's current `faster-whisper` (Whisper large-v3-turbo) backend with NVIDIA's Nemotron Speech models. The primary candidate is `nvidia/nemotron-speech-streaming-en-0.6b` for real-time streaming, with `nvidia/parakeet-tdt-0.6b-v3` as a potential offline/batch alternative.

**Key finding:** Nemotron Speech offers a fundamentally different architecture — native streaming with 43ms latency vs Murmur's current simulated streaming at ~250ms+ cycles. However, integration requires significant backend refactoring (NeMo toolkit, RNNT architecture, different audio pipeline) and limits language support to English only.

**Recommendation:** Pursue integration behind an engine abstraction layer, allowing users to choose between Whisper (multilingual, proven) and Nemotron (lower latency, English-optimized). This preserves the existing experience while unlocking substantially better real-time performance for English users.

---

## 1. Current Architecture Analysis

### 1.1 Transcription Pipeline

Murmur's server uses a straightforward batch-on-timer architecture:

```
Client Audio → WebSocket → AudioBuffer (PCM accumulator)
                                ↓
                    TranscriptionProcessor (every ~250ms)
                                ↓
                    WhisperEngine.transcribe() [thread pool]
                                ↓
                    Partial/Final text → WebSocket → Client
```

**Key components:**

| Component | File | Role |
|-----------|------|------|
| `WhisperEngine` | `server/src/transcription/engine.py` | Singleton wrapper around `faster_whisper.WhisperModel` |
| `TranscriptionProcessor` | `server/src/transcription/processor.py` | Manages partial/final emission with thread pool |
| `AudioBuffer` | `server/src/audio/buffer.py` | Accumulates int16 PCM chunks with sequence tracking |
| `SessionContext` | `server/src/session/context.py` | Per-session state (buffer, timing, config) |
| `websocket/handler.py` | `server/src/websocket/handler.py` | Session lifecycle, partial emission loop, silence monitoring |

### 1.2 Simulated Streaming Model

Murmur does **not** use true streaming transcription. Instead:

1. Audio chunks arrive continuously via WebSocket binary frames (16kHz, 16-bit PCM, mono)
2. `AudioBuffer` accumulates all chunks in memory
3. `_partial_emission_loop` runs on a timer (default 250ms interval, configurable via `partial_emission_interval`)
4. Each cycle, the **entire accumulated buffer** is re-transcribed from scratch via `WhisperEngine.transcribe()`
5. If the result text differs from the previous partial, a `text:partial` frame is emitted
6. On session end (stop or silence timeout), one final full-buffer transcription produces the `text:final` frame

**Implications:**
- Transcription time grows linearly with audio duration (re-transcribing everything each cycle)
- The thread pool (4 workers) offloads blocking Whisper inference from the async event loop
- VAD is handled by Whisper's built-in `vad_filter` (Silero VAD), not a separate component
- Latency = accumulation time + full-buffer inference time + async overhead

### 1.3 Current Model: Whisper large-v3-turbo via faster-whisper

| Property | Value |
|----------|-------|
| Model | `large-v3-turbo` (default, configurable via `MURMUR_WHISPER_MODEL`) |
| Runtime | CTranslate2 (via `faster-whisper` library) |
| Parameters | ~809M |
| Model size | ~3.1 GB |
| VRAM usage | ~4-6 GB (varies by compute type) |
| Languages | 100+ |
| License | MIT (OpenAI Whisper), MIT (faster-whisper) |
| Compute types | auto, int8, int8_float16, int16, float16, float32 |
| Device support | CPU and CUDA |
| Streaming | None (batch model with simulated streaming) |
| VAD | Silero VAD (built into faster-whisper) |
| Dependencies | `faster-whisper>=1.1.0`, `numpy>=1.26.0` |

---

## 2. Nemotron Speech Models

### 2.1 Nemotron Speech Streaming (`nemotron-speech-streaming-en-0.6b`)

Released January 2026, this is NVIDIA's streaming ASR model built for real-time transcription.

| Property | Value |
|----------|-------|
| Full name | `nvidia/nemotron-speech-streaming-en-0.6b` |
| Architecture | FastConformer RNNT (Recurrent Neural Network Transducer) |
| Parameters | 600M |
| Checkpoint size | 2.47 GB (`.nemo` format) |
| VRAM usage | ~2 GB minimum |
| Languages | English only |
| License | CC-BY-4.0 |
| Streaming | Native cache-aware streaming |
| Framework | NVIDIA NeMo toolkit |
| Punctuation | Native (built-in punctuation and capitalization) |
| Sample rate | 16 kHz (matches Murmur) |

#### Architecture Details

The FastConformer RNNT architecture differs fundamentally from Whisper's encoder-decoder:

- **Whisper** (encoder-decoder with attention): Processes the entire audio at once, attends over all positions, generates text autoregressively. Optimized for batch/offline use.
- **FastConformer RNNT** (encoder + prediction network + joint network): Processes audio incrementally. The encoder produces features from audio chunks; the prediction network maintains text history; the joint network combines both to emit tokens. Designed for streaming from the ground up.

Key architectural features:
- **8x downsampling** using depth-wise separable convolutional subsampling (efficient feature extraction)
- **Cache-aware streaming**: Internal caches allow the model to process new audio chunks without re-processing previous audio
- **Configurable chunk sizes**: 80ms, 160ms, 560ms, 1120ms (trade-off between latency and accuracy)

#### Latency Benchmarks

From QbitLoop/RealtimeVoice benchmarks:

| Metric | Nemotron Streaming | Whisper (comparable) |
|--------|-------------------|---------------------|
| GPU inference latency | **43ms** | 916ms |
| Improvement factor | — | **~21x faster** |

On NVIDIA H100 (datacenter scale):
- 560 concurrent streams at 320ms chunk size (3x baseline throughput)
- Demonstrates extreme scalability for server deployments

#### Chunk Size vs Accuracy Trade-off

| Chunk Size | Latency | Accuracy | Use Case |
|-----------|---------|----------|----------|
| 80ms | Ultra-low | Lower | Live captions, real-time feedback |
| 160ms | Very low | Good | Interactive voice apps |
| 560ms | Low | Better | Balanced streaming transcription |
| 1120ms | Moderate | Best | High-accuracy streaming |

For Murmur's use case (push-to-talk voice transcription), 160ms or 560ms chunks would be ideal — providing lower latency than the current ~250ms emission cycle while maintaining good accuracy.

### 2.2 Parakeet-TDT-0.6B-v3 (Offline Alternative)

| Property | Value |
|----------|-------|
| Full name | `nvidia/parakeet-tdt-0.6b-v3` |
| Architecture | FastConformer TDT (Token-and-Duration Transducer) |
| Parameters | 600M |
| Languages | 25 |
| License | CC-BY-4.0 |
| Streaming | No (batch/offline) |
| WER (LibriSpeech clean) | 1.93% |
| WER (LibriSpeech other) | 3.59% |
| WER (Open ASR avg) | 6.34% |
| RTFx | 3386 (real-time factor, higher = faster than real-time) |

This model is relevant as a potential replacement for Whisper in the **final transcription** step, offering better accuracy on English with a much smaller model. However, since it lacks streaming, it wouldn't improve partial emission latency.

---

## 3. Head-to-Head Comparison

### 3.1 Feature Matrix

| Feature | faster-whisper (current) | Nemotron Streaming | Parakeet-TDT v3 |
|---------|------------------------|-------------------|-----------------|
| **Streaming** | Simulated (re-transcribe all) | Native (incremental) | None (batch) |
| **Latency (GPU)** | ~250ms+ cycles, growing | 43ms fixed | N/A (batch) |
| **Parameters** | ~809M | 600M | 600M |
| **VRAM** | ~4-6 GB | ~2 GB | ~2 GB |
| **Languages** | 100+ | English only | 25 |
| **Accuracy (en)** | Very good | Very good (with native punctuation) | Best-in-class (1.93% WER clean) |
| **Punctuation** | Whisper native | Native | Native |
| **VAD** | Silero (built-in) | Needs external or chunk-based | Needs external |
| **Runtime** | CTranslate2 | NeMo / ONNX / TensorRT | NeMo / ONNX / TensorRT |
| **Python deps** | `faster-whisper` (light) | `nemo_toolkit[asr]` (heavy) | `nemo_toolkit[asr]` (heavy) |
| **CPU support** | Yes (good) | Limited (GPU-focused) | Limited (GPU-focused) |
| **License** | MIT | CC-BY-4.0 | CC-BY-4.0 |
| **Model format** | CTranslate2 (.bin) | NeMo (.nemo) | NeMo (.nemo) |

### 3.2 Latency Analysis for Murmur

**Current behavior (faster-whisper):**
```
Audio duration:  0s ──── 1s ──── 2s ──── 5s ──── 10s
Inference time:  ~50ms   ~100ms  ~150ms  ~350ms  ~700ms+
```
Each partial emission re-transcribes the entire buffer. As audio accumulates, inference time grows, eventually exceeding the emission interval. For a 10-second recording, the final transcription might take 700ms+.

**Projected behavior (Nemotron Streaming):**
```
Audio duration:  0s ──── 1s ──── 2s ──── 5s ──── 10s
Inference time:  ~43ms   ~43ms   ~43ms   ~43ms   ~43ms
```
Each chunk is processed independently with cached context. Inference time remains constant regardless of total audio duration. This is the fundamental architectural advantage.

**Impact on Murmur UX:**
- Partial results appear faster and more consistently
- No degradation as recordings get longer
- The overlay text updates would feel more "live"
- Final transcription would be near-instant (last chunk only, not full re-transcription)

### 3.3 Resource Usage

| Resource | faster-whisper (large-v3-turbo) | Nemotron Streaming |
|----------|-------------------------------|-------------------|
| VRAM | ~4-6 GB | ~2 GB |
| RAM | ~2 GB | ~1-2 GB (NeMo overhead varies) |
| Disk (model) | ~3.1 GB | ~2.47 GB |
| Disk (deps) | ~500 MB (CTranslate2 + deps) | ~2-4 GB (NeMo toolkit + PyTorch) |
| CPU fallback | Good performance | Poor/unsupported |
| GPU requirement | Optional (CPU works) | Effectively required |

**Notable:** Nemotron uses less VRAM for the model itself, but the NeMo toolkit dependency is significantly heavier than faster-whisper. The total install footprint would increase substantially.

---

## 4. Integration Considerations

### 4.1 Audio Format Compatibility

Murmur's audio pipeline already uses the format Nemotron expects:

| Parameter | Murmur Current | Nemotron Required | Compatible? |
|-----------|---------------|-------------------|-------------|
| Sample rate | 16 kHz | 16 kHz | Yes |
| Bit depth | 16-bit signed int | Float32 (after conversion) | Yes (conversion exists) |
| Channels | Mono | Mono | Yes |
| Encoding | PCM | PCM | Yes |

The `AudioBuffer.get_audio_float32()` method already converts int16 PCM to float32 normalized to [-1.0, 1.0], which is the standard input format for NeMo models. No audio pipeline changes needed.

### 4.2 Streaming Architecture Change

The most significant change is moving from "re-transcribe everything" to "process new chunks incrementally":

**Current flow (faster-whisper):**
```python
# Every 250ms cycle:
audio = buffer.get_audio_float32()  # ALL accumulated audio
result = engine.transcribe(audio)    # Re-transcribe everything
```

**Required flow (Nemotron):**
```python
# For each new chunk:
new_audio = buffer.get_new_chunks_float32()  # Only new audio since last call
tokens = engine.process_chunk(new_audio)      # Incremental, uses internal cache
# Tokens are emitted immediately as they're produced
```

This requires:
1. **AudioBuffer changes**: Track which audio has been consumed vs. newly arrived (a "cursor" or "mark" mechanism)
2. **Engine state management**: Nemotron's cache-aware streaming maintains internal state between chunks. This state is per-session and must be created/destroyed with the session lifecycle.
3. **Emission model change**: Instead of periodic timer-based emission, tokens can be emitted as soon as the RNNT decoder produces them. The partial emission loop would be replaced (or supplemented) by a callback/event-driven model.
4. **No full re-transcription for finals**: The final result is the accumulated tokens, not a separate full-buffer transcription pass.

### 4.3 NeMo Toolkit Integration

The `nemo_toolkit[asr]` package is the primary dependency. Key considerations:

**Dependency weight:**
- NeMo pulls in PyTorch, TorchAudio, and numerous NVIDIA libraries
- Total install size: 2-4 GB+ (vs. ~500 MB for faster-whisper's CTranslate2)
- This significantly increases server startup time and disk usage

**Inference API (pseudocode based on NeMo patterns):**
```python
import nemo.collections.asr as nemo_asr

# Load model
model = nemo_asr.models.ASRModel.from_pretrained("nvidia/nemotron-speech-streaming-en-0.6b")

# Configure for streaming
model.change_decoding_strategy(None)  # Use default streaming decoding

# Per-session streaming state
cache = model.encoder.get_initial_cache()

# Process chunk
logits, cache = model.encoder(audio_chunk, cache=cache)
tokens = model.decoding.decode(logits)
text = model.tokenizer.ids_to_text(tokens)
```

**Alternative runtimes:**
- **ONNX Runtime**: Export `.nemo` → ONNX for lighter deployment (no full NeMo needed at inference)
- **TensorRT**: Maximum GPU performance, but adds build complexity
- **Triton Inference Server**: Production-grade serving, overkill for single-user desktop app

For Murmur's desktop use case, ONNX Runtime would be the ideal middle ground — lighter than full NeMo, better performance than raw PyTorch, no TensorRT build step.

### 4.4 Session Lifecycle Impact

Current session lifecycle (from `websocket/handler.py`):

```
connect → start → ready → [audio streaming + partial loop] → stop/timeout → final → closing → close
```

With Nemotron streaming, the session lifecycle stays the same at the protocol level, but internals change:

1. **Session creation**: Initialize Nemotron cache state alongside AudioBuffer
2. **Audio streaming**: Instead of accumulating and re-transcribing, feed chunks directly to the model
3. **Partial emission**: Driven by model output (new tokens) rather than a timer
4. **Final emission**: Flush remaining cache state, emit accumulated text
5. **Session cleanup**: Release cache memory (GPU tensors)

The WebSocket protocol (`docs/protocol.md`) requires **no changes** — partial and final text frames work the same way regardless of the underlying engine.

### 4.5 VAD Considerations

Whisper's built-in Silero VAD handles voice activity detection in the current setup. Nemotron's RNNT architecture inherently handles silence (it simply doesn't emit tokens when there's no speech), but Murmur also uses VAD for:

1. **Silence timeout detection** (`_silence_monitor_loop`): Ends session after N seconds of silence
2. **Speech timing** (`last_speech_time`, `last_speech_end`): Tracks when speech was last detected

With Nemotron, silence detection would need to be based on token emission timing (no tokens = no speech) rather than explicit VAD output. This is a minor adaptation in the silence monitoring logic.

---

## 5. Migration Strategy

### 5.1 Engine Abstraction Layer

The cleanest path is an abstraction that allows both engines to coexist:

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class TranscribeResult:
    text: str
    confidence: float
    is_final: bool
    last_speech_end: float | None

class TranscriptionEngine(ABC):
    """Abstract base for transcription engines."""

    @abstractmethod
    async def start_session(self) -> "EngineSession":
        """Create a new streaming session."""
        ...

    @abstractmethod
    def shutdown(self) -> None:
        """Release model resources."""
        ...

class EngineSession(ABC):
    """Abstract base for per-session engine state."""

    @abstractmethod
    async def process_audio(self, audio: NDArray[np.float32]) -> list[TranscribeResult]:
        """Process an audio chunk, returning any new results."""
        ...

    @abstractmethod
    async def finalize(self) -> TranscribeResult:
        """Flush remaining state and return final result."""
        ...

    @abstractmethod
    def close(self) -> None:
        """Release session resources."""
        ...
```

**WhisperEngine adapter** would wrap the current re-transcribe-everything approach behind this interface, maintaining backward compatibility.

**NemotronEngine adapter** would implement true incremental streaming, managing per-session cache state.

### 5.2 Configuration

Extend `Settings` to support engine selection:

```python
class Settings(BaseSettings):
    # Engine selection
    engine: Literal["whisper", "nemotron"] = "whisper"

    # Whisper settings (existing)
    whisper_model: str = "large-v3-turbo"
    whisper_device: Literal["auto", "cpu", "cuda"] = "auto"
    whisper_compute_type: str = "auto"

    # Nemotron settings (new)
    nemotron_model: str = "nvidia/nemotron-speech-streaming-en-0.6b"
    nemotron_chunk_ms: int = 560  # Chunk size in ms
    nemotron_device: str = "cuda"  # GPU effectively required
```

### 5.3 Phased Rollout

**Phase 1: Abstraction** (no new dependencies)
- Define `TranscriptionEngine` / `EngineSession` interfaces
- Wrap existing `WhisperEngine` as `WhisperTranscriptionEngine`
- Refactor `TranscriptionProcessor` to use the abstract interface
- All tests pass, no behavior change

**Phase 2: Nemotron Integration** (add NeMo dependency)
- Implement `NemotronTranscriptionEngine` + `NemotronSession`
- Adapt `AudioBuffer` with cursor/mark for incremental consumption
- Update partial emission to support event-driven mode
- Add `engine` config switch

**Phase 3: Optimization**
- ONNX Runtime export for lighter deployment
- Benchmark and tune chunk sizes for Murmur's use case
- Optional: hybrid mode (Nemotron for partials, Parakeet-TDT for final)

---

## 6. Risk Assessment

### 6.1 Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **English only** — Nemotron streaming is English-only; Murmur users may need other languages | High | Keep Whisper as default, Nemotron as opt-in for English users |
| **NeMo dependency weight** — 2-4 GB+ install, slow startup | Medium | Explore ONNX export to avoid full NeMo at runtime |
| **GPU required** — Nemotron has poor/no CPU fallback | Medium | Document requirement; Whisper remains CPU-capable default |
| **NeMo API stability** — NeMo toolkit has frequent breaking changes across versions | Medium | Pin version, consider ONNX export for decoupling |
| **Cache memory leaks** — Per-session GPU cache state must be properly cleaned up | Low | Careful lifecycle management in `EngineSession.close()` |
| **License change** — CC-BY-4.0 vs MIT has attribution requirements | Low | Add attribution in about/credits; CC-BY-4.0 is permissive |
| **Accuracy regression** — RNNT streaming may be less accurate than Whisper batch on some content | Low | User can switch engines; provide both options |

### 6.2 Opportunities

| Opportunity | Impact |
|-------------|--------|
| **~21x latency reduction** — 43ms vs 916ms on GPU | Transformative UX improvement for live overlay |
| **Constant-time inference** — No degradation on long recordings | Removes current scaling limitation |
| **Lower VRAM** — 2 GB vs 4-6 GB | Enables use on more GPUs, leaves room for other tasks |
| **Smaller model** — 600M vs 809M params | Faster load, less memory |
| **Native punctuation** — No post-processing needed | Simpler pipeline, better results |
| **Future NVIDIA models** — Engine abstraction enables easy adoption | Architectural flexibility |

---

## 7. Alternatives Considered

### 7.1 Whisper Streaming Libraries

Several projects add streaming to Whisper (e.g., `whisper_streaming`, `faster-whisper` with local agreement). These use a sliding window or chunked approach but still re-run the encoder on overlapping windows. They offer marginal improvement over Murmur's current approach without the architectural benefits of a native streaming model.

### 7.2 Distil-Whisper

Distilled versions of Whisper (e.g., `distil-large-v3`) offer 5-6x speedup with minimal accuracy loss. This could be a simpler upgrade path — just changing `MURMUR_WHISPER_MODEL` — but doesn't address the fundamental re-transcription scaling problem.

### 7.3 Whisper.cpp / whisper-rs

C/C++ Whisper implementations offer better CPU performance but have the same batch architecture limitations. Useful if CPU performance is the bottleneck, but Murmur already targets GPU users.

### 7.4 Moonshine (Useful Sensors)

A lightweight streaming ASR model designed for edge devices. Smaller than Nemotron but less accurate. Could be relevant for CPU-only deployment scenarios.

---

## 8. Conclusion

Nemotron Speech Streaming represents a generational improvement in real-time ASR for Murmur's use case. The 43ms constant-time inference eliminates the growing-latency problem inherent in Whisper's batch architecture, while using less VRAM.

The primary trade-offs are:
1. **English only** (vs. 100+ languages with Whisper)
2. **GPU required** (vs. Whisper's viable CPU mode)
3. **Heavier dependencies** (NeMo toolkit vs. lighter faster-whisper)

The recommended path is a **dual-engine architecture** behind an abstraction layer, preserving Whisper as the default while offering Nemotron as an opt-in upgrade for English-speaking GPU users. This approach:
- Maintains backward compatibility
- Requires no protocol changes
- Enables future engine additions (Parakeet-TDT for finals, future NVIDIA models, etc.)
- Lets users choose the best trade-off for their needs

The engine abstraction should be implemented first (Phase 1) as a pure refactor with no new dependencies, followed by Nemotron integration (Phase 2) once the abstraction is proven.
