# Research: Custom Word List for Improved Recognition

Date: 2026-02-06

## Goal

Evaluate how to support a user-defined word list that improves transcription accuracy for names, jargon, product terms, and acronyms.

## Current State in Murmur

- The app sends a `start` control frame with `silence_timeout` (and optional `partial_emission_interval`) only.
- Server transcription currently calls `WhisperModel.transcribe(...)` without `initial_prompt` or `hotwords`.
- No settings field exists yet for custom vocabulary.

Relevant files:
- `app/src/shared/protocol.ts`
- `app/src/main/services/transcription.ts`
- `server/src/protocol/frames.py`
- `server/src/websocket/handler.py`
- `server/src/transcription/engine.py`
- `app/src/shared/types.ts`

## Findings from faster-whisper

Murmur is locked to `faster-whisper 1.2.1` in `server/uv.lock`, which supports both `initial_prompt` and `hotwords`.

Key behavior from upstream implementation:

1. `hotwords` is a first-class `transcribe(...)` argument.
2. `hotwords` is injected into prompt construction for decoding windows.
3. `hotwords` has no effect if `prefix` is set (not relevant for Murmur if we do not use `prefix`).
4. Prompt context budget is limited (`max_length = 448`; effective carried prompt slice is about half-context).
5. Overly long hints are truncated to fit prompt budget.

Practical implication: use concise high-value hints, not long dictionaries.

## Initial Prompt vs Hotwords

### `initial_prompt`

- Good for style/context priming and vocabulary nudging.
- In Whisper ecosystems, can help proper nouns and jargon, but effect varies by audio quality and utterance length.
- Less explicit for "term boosting" than `hotwords`.

### `hotwords`

- Explicit feature for hint phrases.
- Better semantic fit for this idea than `initial_prompt`.
- More direct integration path in Murmur because we can pass it per session.

## Candidate Approaches

### A) Bias only (recommended first)

- Store user custom terms.
- Send as `hotwords` in start frame.
- Pass through to `WhisperModel.transcribe(hotwords=...)`.

Pros: low complexity, minimal protocol/UI impact, reversible.
Cons: probabilistic, not guaranteed corrections.

### B) Replacement map only

- Post-process final text using explicit replacement rules (`wrong -> correct`).

Pros: deterministic and testable.
Cons: can introduce false replacements; hard to generalize.

### C) Hybrid (likely best long-term)

- Use `hotwords` for recall.
- Optional replacement map for persistent misses.

## Suggested Data Model (v1)

Keep v1 intentionally small:

- `customWords: string[]`
- Normalize on save: trim, dedupe, preserve original casing.
- Reject empty entries.
- Soft limit by count and total length (token budget safety).

Do not add replacement rules in v1 unless needed by test results.

## Protocol / Pipeline Proposal

1. Extend start frame schema with optional `hotwords` string (or `custom_words` array, serialized server-side).
2. Store in `SessionContext`.
3. Thread through `TranscriptionProcessor` to `WhisperEngine.transcribe(...)`.
4. Apply to both partial and final transcription calls.

Compatibility note:
- Current protocol rules already favor forward compatibility; unknown fields are ignored by clients/servers that do not use them.

## Risks and Constraints

- Prompt budget is finite: too many words can dilute effectiveness.
- False positives: model may over-prefer hinted spellings in nearby words.
- Acronym behavior can be inconsistent (e.g., "IPC" vs spaced variants).
- Multi-language sessions may need language-scoped lists later.

## Validation Plan

Run a small benchmark before and after biasing:

1. Build a phrase set (20-50 terms) with expected spellings.
2. Record short audio clips containing those terms in realistic sentences.
3. Measure:
   - term-level exact match rate
   - sentence-level WER (or simple edit distance if WER tooling is unavailable)
   - latency impact on partial and final transcribe times
4. Compare baseline vs `hotwords` with varying list sizes.

Success criteria for v1:

- Meaningful lift in target-term accuracy.
- No major regression in unrelated text quality.
- No unacceptable latency increase.

## Recommendation

Implement a narrow v1 around `hotwords` first, then evaluate whether deterministic replacements are necessary.

If metrics are good, follow with:

1. UI management in Settings (add/edit/remove).
2. Import/export JSON word lists.
3. Optional categories (future: mode-specific lists).
