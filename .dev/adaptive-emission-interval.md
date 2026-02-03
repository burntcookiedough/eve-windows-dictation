# Adaptive Partial Emission Interval

**Status:** ✅ Implemented
**Date:** 2026-02-03

## Problem Statement

When transcription processing time exceeds the emission interval, what happens? Could audio chunks queue up and cause issues?

The concern is that if the server can't keep up with incoming audio, there might be a feedback loop where:
1. Audio accumulates faster than it's processed
2. Larger buffer → longer transcription time
3. Longer transcription → more accumulation
4. Potential latency spikes or memory issues

## Current Architecture Analysis

### Client Side (app/)

- **Chunk size:** 1600 samples = 100ms at 16kHz (fixed in `constants.ts`)
- **Sending:** AudioWorklet captures → IPC to main → WebSocket send
- **No backpressure:** Chunks sent immediately, silent drop if connection not ready
- **No awareness** of server processing state

### Server Side (server/)

- **Buffer:** All audio chunks accumulate in unbounded `_chunks` list
- **Emission loop:** Fixed 500ms `asyncio.sleep()` BEFORE each transcription attempt
- **Transcription:** Processes ENTIRE accumulated buffer each time (not just new audio)
- **No rate limiting:** Accepts all frames without checking buffer size

### Current Emission Loop (`handler.py:279-315`)

```python
async def _partial_emission_loop(..., interval: float):
    while context.state_machine.is_active():
        await asyncio.sleep(interval)  # Sleep FIRST, fixed 500ms
        # ... do transcription (takes X ms)
```

**Issue:** Cycle time = 500ms + transcription_time

If transcription takes 300ms, cycle is 800ms total. The sleep happens regardless of how long the previous transcription took.

### Config (`config.py:34`)

```python
partial_emission_interval: float = 0.5  # Seconds between partial emissions
```

## Analysis: Is This Actually a Problem?

### Realistic Scenario

| Time | Buffer Size | Transcription Time (estimate) | Cycle Time |
|------|-------------|-------------------------------|------------|
| 0.5s | 500ms audio | ~0.1-0.2s | 600-700ms |
| 2.0s | 2000ms audio | ~0.3-0.5s | 800-1000ms |
| 5.0s | 5000ms audio | ~0.5-1.0s | 1000-1500ms |

With modern GPU/good CPU, transcription is typically fast enough that this isn't catastrophic. But:
- The fixed sleep is inefficient (wastes time after slow transcription)
- Initial feedback could be faster (200ms instead of 500ms)
- On slower hardware or with longer audio, the system doesn't adapt

### What Backpressure Exists?

- **Application level:** None
- **TCP level:** Implicit backpressure when buffers fill, but hidden from app
- **Protocol:** Doesn't define any flow control

## Considered Approaches

### 1. Adaptive chunk sizing on client
- Server sends processing time, client batches more audio per frame
- **Rejected:** Adds complexity, client's job is just to capture reliably

### 2. Server-initiated backpressure (protocol change)
- Add message like `{ "type": "throttle", "interval_ms": 200 }`
- **Rejected:** Adds protocol complexity, client still needs all audio delivered

### 3. Sliding window on server
- Only transcribe last N seconds instead of entire buffer
- **Rejected:** Would lose context, Whisper benefits from full audio

### 4. Adaptive emission interval on server (PROPOSED)
- Keep client sending fixed chunks
- Server adjusts timing dynamically based on transcription speed
- **Preferred:** Simple, server-only change, naturally adapts to hardware

## Proposed Solution

### Change the Emission Loop

**From (current):**
```python
while context.state_machine.is_active():
    await asyncio.sleep(interval)  # Fixed sleep BEFORE transcription
    result = await processor.transcribe_partial()
    # ...
```

**To (proposed):**
```python
while context.state_machine.is_active():
    start = time.monotonic()
    result = await processor.transcribe_partial()
    # ...
    elapsed = time.monotonic() - start
    remaining = min_interval - elapsed
    if remaining > 0:
        await asyncio.sleep(remaining)
```

### Behavior

- Transcription takes 100ms, min_interval 200ms → sleep 100ms → next at 200ms mark
- Transcription takes 300ms, min_interval 200ms → no sleep → next immediately
- Transcription takes 50ms, min_interval 200ms → sleep 150ms → next at 200ms mark

Cycle time = `max(min_interval, transcription_time)` (optimal)

### Config Changes

```python
# Rename for clarity
partial_emission_min_interval: float = 0.2  # Lower default for snappier feedback
```

Or keep both names with deprecation if needed for compatibility.

## Benefits

1. **Faster initial feedback** - 200ms instead of 500ms when audio is short
2. **Natural adaptation** - slower hardware just runs as fast as it can
3. **No wasted time** - never sleeps unnecessarily after slow transcription
4. **Configurable floor** - users can tune responsiveness vs. CPU usage
5. **No protocol changes** - fully backwards compatible
6. **Server-only change** - client unaffected

## Scope

- **Files to modify:**
  - `server/src/config.py` - rename/adjust default
  - `server/src/websocket/handler.py` - change `_partial_emission_loop`
- **No changes to:**
  - Protocol (`docs/protocol.md`)
  - Client (`app/`)
  - Any other server files

## Open Questions

1. What should the default `min_interval` be? (200ms suggested, could be lower)
2. Should we add logging to track actual cycle times for debugging?
3. Should `min_audio_for_transcription` (currently 0.5s) also be adjusted to match?

## Implementation Notes

### Changes Made

**Protocol** (`docs/protocol.md`):
- Added optional `partial_emission_interval` field to `start` control frame

**Server**:
- `server/src/config.py` - Changed default from 0.5s to 0.2s
- `server/src/protocol/frames.py` - Added `partial_emission_interval` field to `StartFrame`
- `server/src/session/context.py` - Added `partial_emission_interval` field
- `server/src/websocket/handler.py` - Implemented adaptive emission loop:
  - Sleep happens AFTER transcription, only for remaining time
  - Cycle time = `max(min_interval, transcription_time)`
  - Added debug logging for cycle timing

**App**:
- `app/src/shared/types.ts` - Added `partialEmissionInterval` to `Settings`
- `app/src/shared/protocol.ts` - Added field to `ControlFrameStart`
- `app/src/main/services/settings.ts` - Handle new setting
- `app/src/main/services/transcription.ts` - Send interval in start frame
- `app/src/main/index.ts` - Pass setting to TranscriptionService
- `app/src/renderer/app/views/SettingsView.svelte` - Added UI dropdown with presets:
  - 100ms (Fastest)
  - 200ms (Recommended) - default
  - 300ms
  - 500ms (Slower)

**Documentation**:
- `README.md` - Added Configuration section with all server environment variables
