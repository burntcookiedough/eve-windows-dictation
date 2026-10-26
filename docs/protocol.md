# Live Voice Transcription Protocol v1

## Overview

This document defines a WebSocket-based protocol for live voice transcription. A client sends audio data and receives transcribed text in near real-time.

Each WebSocket connection represents a single transcription session. The session begins with a `start` control frame, accepts audio frames, emits partial and final text results, and ends with connection close.

## Transport

WebSocket (RFC 6455) over TCP. TLS recommended for production.

## Frame Categories

| Category | WebSocket Type | Direction | Purpose |
|----------|----------------|-----------|---------|
| Audio | Binary | Client → Server | Raw audio data |
| Control | Text (JSON) | Bidirectional | Session management |
| Text | Text (JSON) | Server → Client | Transcription results |

---

## Audio Frames

Binary frames containing a fixed header followed by raw PCM audio data.

### Wire Format

```
┌──────────────────┬──────────────────┬───────────┬─────────────────┐
│ Sequence (2B)    │ Sample Count (2B)│ Flags (1B)│ PCM Data (var)  │
└──────────────────┴──────────────────┴───────────┴─────────────────┘
```

| Field | Type | Description |
|-------|------|-------------|
| Sequence | uint16, big-endian | Frame sequence number, wraps at 65535 |
| Sample Count | uint16, big-endian | Number of audio samples in this frame |
| Flags | uint8 | Reserved, must be `0x00` |
| PCM Data | bytes | Raw audio samples |

### Audio Format

- Sample rate: 16000 Hz
- Bit depth: 16-bit signed
- Channels: Mono
- Byte order: Little-endian

### Client Behavior

Send audio frames continuously after receiving `ready` control frame. Typical frame interval is 100-200ms. Sequence numbers should increment by 1 per frame, starting at 0.

### Server Behavior

Process audio frames in sequence order. Sequence gaps indicate dropped frames (log for debugging, do not error). If audio frames are received before `start`, respond with `error` control frame and close connection.

### Size Validation

The PCM data length must exactly equal `sample_count × 2` bytes (16-bit = 2 bytes per sample). Any mismatch is an `invalid_audio` error.

---

## Control Frames

JSON-encoded text frames for session management.

All control frames have:
- `frame`: always `"control"`
- `type`: the specific control frame type

### Extensibility

- Unknown `type` values: ignore silently (log warning), do not affect session
- Unknown fields: ignore silently (log warning), do not affect processing
- Invalid JSON: server responds with `error` (code `invalid_ctrl`), closes connection

### start (Client → Server)

Initiates a transcription session.

```json
{
  "frame": "control",
  "type": "start",
  "silence_timeout": 5,
  "partial_emission_interval": 0.2,
  "hotwords": "Kubernetes, Svelte, IPC"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `frame` | string | yes | `"control"` |
| `type` | string | yes | `"start"` |
| `silence_timeout` | number | yes | Seconds of silence before auto-stop |
| `partial_emission_interval` | number | no | Minimum seconds between partial emissions (default: 0.2) |
| `hotwords` | string | no | Comma-separated hint phrases to bias recognition toward custom terms |

**Server behavior:**
- Valid: respond with `ready`, begin accepting audio frames
- Already received `start` this session: ignore silently
- Missing/invalid fields: respond with `error` (code `invalid_start`), close connection

### stop (Client → Server)

Explicitly ends the session.

```json
{
  "frame": "control",
  "type": "stop"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `frame` | string | yes | `"control"` |
| `type` | string | yes | `"stop"` |

**Server behavior:**
1. Finalize any pending transcription
2. On successful inference, send exactly one `final` text frame (may be empty when no speech was recognized); on failure, use the incomplete-recovery sequence below
3. Send `closing` control frame with reason `"stop_received"`
4. Close WebSocket connection

### ready (Server → Client)

Confirms session started. Server is now accepting audio.

```json
{
  "frame": "control",
  "type": "ready",
  "engine": {
    "id": "whisper",
    "name": "Faster-Whisper",
    "model": "large-v3-turbo",
    "supports_hotwords": true,
    "languages": ["en", "de", "fr", "es", "it", "ja", "zh", "nl", "ko", "pt"],
    "model_size_gb": 1.5
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `frame` | string | `"control"` |
| `type` | string | `"ready"` |
| `engine` | object | Optional compatibility metadata for the Faster-Whisper model serving this session (may be omitted) |

**Client behavior:** Begin sending audio frames.

### error (Server → Client)

Fatal error. Connection will close immediately after.

```json
{
  "frame": "control",
  "type": "error",
  "code": "no_start",
  "message": "Audio received before start"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `frame` | string | `"control"` |
| `type` | string | `"error"` |
| `code` | string | Machine-readable error code |
| `message` | string | Human-readable description |

#### Error Codes

| Code | Meaning |
|------|---------|
| `no_start` | Audio frame received before `start` |
| `invalid_start` | `start` frame malformed or missing required fields |
| `invalid_audio` | Audio frame malformed (bad header, wrong size) |
| `invalid_ctrl` | Control frame is not valid JSON |
| `start_timeout` | Client did not send `start` within allowed time after connecting |
| `rate_limit` | Too many connections or requests |
| `internal` | Server-side error |

**Client behavior:** Log the error. Connection will close.

### warning (Server → Client)

Non-fatal warning. Session continues and connection remains open.

```json
{
  "frame": "control",
  "type": "warning",
  "code": "vram_exhausted",
  "message": "GPU VRAM exhausted during transcription; using last successful result."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `frame` | string | `"control"` |
| `type` | string | `"warning"` |
| `code` | string | Machine-readable warning code |
| `message` | string | Human-readable warning message |

#### Warning Codes

| Code | Meaning |
|------|---------|
| `vram_exhausted` | GPU VRAM exhausted during transcription; server falls back to last successful text |

**Client behavior:** Surface warning to user and continue sending audio normally.

### status (Server → Client)

Non-terminal progress/status update. Clients that do not understand a status value may ignore it.

```json
{
  "frame": "control",
  "type": "status",
  "status": "long_dictation_processing",
  "message": "Processing chunk 2/3",
  "chunk_index": 2,
  "chunk_total": 3,
  "audio_duration": 62.8
}
```

| Field | Type | Description |
|-------|------|-------------|
| `frame` | string | `"control"` |
| `type` | string | `"status"` |
| `status` | string | Machine-readable status |
| `message` | string | Optional human-readable status |
| `chunk_index` | number | Optional 1-based chunk number |
| `chunk_total` | number | Optional total chunk count |
| `audio_duration` | number | Optional current/full audio duration in seconds |

#### Status Values

| Status | Meaning |
|--------|---------|
| `long_dictation_started` | Buffered audio crossed the server's long-dictation threshold and final transcription will use long mode |
| `long_dictation_processing` | Final long-dictation transcription is processing a specific chunk |

**Client behavior:** Surface mode/progress without treating it as terminal text.

### closing (Server → Client)

Server is about to close the connection. Sent after the terminal `final` text frame on success, or after a finalization `error` on failure.

```json
{
  "frame": "control",
  "type": "closing",
  "reason": "silence_timeout"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `frame` | string | `"control"` |
| `type` | string | `"closing"` |
| `reason` | string | Why the session is ending |

#### Closing Reasons

| Reason | Meaning |
|--------|---------|
| `stop_received` | Client sent `stop` |
| `silence_timeout` | No speech detected for configured duration |

**Client behavior:** Prepare for connection close. No further frames will arrive.

---

## Text Frames

JSON-encoded text frames containing transcription results.

All text frames have:
- `frame`: always `"text"`
- `type`: either `"partial"` or `"final"`

### Extensibility

- Unknown `type` values: ignore silently (log warning)
- Unknown fields: ignore silently (log warning)
- Invalid JSON received by client: client implementation concern, not defined by protocol

### partial (Server → Client)

Interim transcription result. Speculative — may change.

```json
{
  "frame": "text",
  "type": "partial",
  "text": "hello how are",
  "confidence": 0.72,
  "transcription_time": 0.142,
  "audio_duration": 2.5
}
```

| Field | Type | Description |
|-------|------|-------------|
| `frame` | string | `"text"` |
| `type` | string | `"partial"` |
| `text` | string | Current transcription hypothesis |
| `confidence` | number | Confidence score, 0.0 to 1.0 |
| `transcription_time` | number | Time in seconds for transcription processing (see below) |
| `audio_duration` | number | Duration in seconds of the audio transcribed |

**`transcription_time` includes:** reading audio from buffer, converting to float32, and model inference. **Does not include:** network latency, audio capture, or any post-processing.

**Client behavior:** Replace any previously displayed partial text with this text. Do not persist.

**Note:** Empty `text` values may occur (e.g., server reconsidered a noise as non-speech).

### final (Server → Client)

Committed transcription result. Will not change.

```json
{
  "frame": "text",
  "type": "final",
  "text": "hello how are you",
  "confidence": 0.94,
  "transcription_time": 0.156,
  "audio_duration": 3.2
}
```

| Field | Type | Description |
|-------|------|-------------|
| `frame` | string | `"text"` |
| `type` | string | `"final"` |
| `text` | string | Finalized transcription (may be empty when no speech was recognized) |
| `confidence` | number | Confidence score, 0.0 to 1.0 |
| `transcription_time` | number | Time in seconds for transcription processing (see below) |
| `audio_duration` | number | Duration in seconds of the audio transcribed |

**`transcription_time` includes:** reading audio from buffer, converting to float32, and model inference. **Does not include:** network latency, audio capture, or any post-processing.

**Client behavior:** Treat this as terminal session text. Clear partial buffer.

**Note:** Empty `final` frames can be sent when silence/no-speech is detected.

### Emission Rules

1. A `final` frame is emitted on normal session termination (client `stop`, silence timeout).
2. Once a `final` is sent, no further `partial` frames are sent for that session.
3. Successful finalization follows: zero or more `partial` → one terminal `final` → `closing` → connection close.

#### Incomplete inference recovery

When native inference fails, completed segments from that call and completed
long-dictation chunks remain available as **incomplete** text. A failed primary
chunk stops further chunk inference; it is not silently skipped. An optional
low-confidence retry that runs out of GPU memory retains its completed first
pass. Other retry failures retain that first pass and report incomplete output.
Recognized CUDA OOM uses the internal `VramExhaustedError`; other native errors
retain their original exception as the cause of `IncompleteTranscriptionError`.

Failed finalization sends an optional replacement `partial` containing available
text, then `error` (`code: "internal"`, explicitly describing incomplete text),
then `closing` and connection close. It emits **no successful `final`**. Recovery
does not substitute a prior chunk's result at a new audio offset. Successful
silence emits an empty final rather than substituting an earlier partial.
The frame shapes and existing error/closing codes are unchanged.

Clients must retain failure provenance across `closing` and socket closure.
Recovered text is for explicit review/recovery, not normal automatic paste or
successful History insertion. The desktop client commits only an explicit
successful `final`, once per session. An error, unexpected disconnect, or
`closing` without a final stays failed; none synthesizes a successful final.
Late text/status/warning frames cannot change an already-terminal outcome.
Recovered partial text remains available in memory for review until the next
recording; it is not automatically pasted or stored as successful History.
Packaged insertion and physical microphone behavior still need product testing.

Before a user-requested stop reaches the server, the desktop drains capture:
the worklet stops producing PCM and sends an ordered marker after queued audio.
The renderer forwards that audio before acknowledging the same capture session
to main. Main accepts audio only for the active session, including its drain,
then sends WebSocket `stop`. A missing marker (1 second) or acknowledgement
(2 seconds) aborts with an explicit incomplete/error outcome. Stale session
audio, stop commands and acknowledgements cannot affect the next recording.
These session identifiers are internal IPC metadata; the WebSocket audio and
control frame formats are unchanged. Server-initiated terminal frames force
capture teardown rather than requesting another successful stop.

Chunk deduplication requires matching segment text at overlapping absolute audio
times. Equal words at different times remain intact. Segments crossing the
overlap boundary, or transcripts without timing evidence, are retained in full;
this conservative policy can leave ambiguous overlap repeated rather than
delete potentially intentional speech. Decoder defaults are unchanged. Packaged
accuracy and boundary behavior still require product validation.

Cancellation of the async inference await does not stop native executor work.
Processor teardown retains the generation lease through actual completion (or
cancellation before execution) of every submitted job; it rejects later work.

---

## Session Lifecycle

```
Client                                   Server
   │                                        │
   │────────── WebSocket Connect ──────────►│
   │                                        │
   │──── control:start ────────────────────►│
   │◄──────────────────── control:ready ────│
   │                                        │
   │──── [audio frame seq=0] ──────────────►│
   │──── [audio frame seq=1] ──────────────►│
   │◄────────────────────── text:partial ───│
   │──── [audio frame seq=2] ──────────────►│
   │◄────────────────────── text:partial ───│
   │                                        │
   │──── control:stop ─────────────────────►│
   │◄──────────────────────── text:final ───│
   │◄────────────────────── control:closing │
   │                                        │
   │◄────────── WebSocket Close ───────────►│
```

## Session End Conditions

A session ends when any of the following occur:

1. **Client sends `stop`** — Server finalizes, sends terminal `final` (possibly empty), sends `closing` with reason `stop_received`, closes connection.

2. **Silence timeout** — No speech detected for `silence_timeout` seconds. Server sends terminal `final` (possibly empty), sends `closing` with reason `silence_timeout`, closes connection.

3. **Client closes connection** — Server treats as implicit stop, cleans up resources.

4. **Fatal error** — Server sends `error` and closes without a successful `final`. A finalization failure uses the incomplete-recovery sequence above, including `closing`; earlier fatal protocol errors may close immediately.

5. **Non-fatal warning** — Server may send `warning` at any time during an active session. Session continues.

## Optional test timing diagnostics

With explicit `MURMUR_PERF_TRACE=1` opt-in, clients may supply start `trace_id`
(1-64 ASCII letters, digits, underscores, periods or hyphens). The server echoes
that token as final `perf.session_id`; without a token it generates a random ID.
This optional final object contains only fixed numeric/null timing fields in the
`python_perf_counter` domain and partial-task state. Ordinary frames omit these
fields, partial frames are unchanged, and existing clients may ignore them.
See [B4 timing definitions](architecture/eve-b4-timing-definitions.md) for exact
boundaries, clock separation, unavailable stages, and bounded opt-in logging.
No text/audio is included in timing diagnostics and no recording is started.
