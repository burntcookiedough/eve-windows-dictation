# Research: Custom Word List for Improved Recognition (Evidence-Backed)

Date: 2026-02-07

## Scope

Determine the most effective and lowest-risk way to improve recognition of domain words (names, acronyms, product terms, jargon) in Murmur, with explicit references for every design claim.

## Executive Findings

1. Murmur is currently not passing any vocabulary biasing signals to the backend model; start frames only carry timeout/interval controls. [C1][C2][C3][C4][C5]
2. Murmur runs `faster-whisper==1.2.1` with `ctranslate2==4.6.3`; this version supports both `initial_prompt` and `hotwords`. [C7][C8][E1]
3. For this feature, `hotwords` is a better v1 primitive than `initial_prompt` because it is explicitly intended as hint phrases and applied repeatedly in prompt construction logic. [E1][E2][E4]
4. Hotword effectiveness is bounded by prompt budget: faster-whisper hard-limits prompt length (`max_length=448`) and truncates hotwords to half-context. [E2]
5. Biasing improves target-term recall but can increase false positives/hallucination behavior if over-weighted or over-long; this is echoed in cloud provider guidance and faster-whisper field reports. [E4][E5][E6][E7]
6. Strongest path is phased: (a) hotword biasing v1, (b) evaluate with WER + term recall, (c) add optional deterministic replacement mapping only if benchmark data shows persistent misses. [E11][C9][C10]

## Current Murmur Baseline (What Exists Today)

- Client start frame schema has `silence_timeout` and optional `partial_emission_interval`; no vocabulary field. [C1]
- Client sends only `silence_timeout` in practice from `TranscriptionService.sendStartFrame`. [C2]
- Server `StartFrame` validates timeout/interval only; no vocabulary field today. [C3]
- Session context stores timeout/interval from start frame; no vocabulary state carried per session. [C4]
- Whisper engine call uses `WhisperModel.transcribe(audio, language, vad_filter, vad_parameters)` without `hotwords`/`initial_prompt`. [C5]
- App settings model has no `customWords` field yet. [C6]

Conclusion: the feature is absent in protocol, settings, session context, and engine call path. [C1][C2][C3][C4][C5][C6]

## External Evidence on Biasing Mechanisms

### 1) `initial_prompt` behavior

- OpenAI Whisper documents `initial_prompt` as prompt text for the first window; `carry_initial_prompt` is a separate control if you want to prepend it repeatedly. [E3]
- In practical long-form usage, first-window-only prompting is often insufficient for terms that appear later. [E4]

### 2) `hotwords` behavior in faster-whisper

- `hotwords` is a first-class argument on `WhisperModel.transcribe`. [E1]
- Upstream docs state `hotwords` has no effect if `prefix` is set. [E1]
- Prompt construction path injects hotwords under `sot_prev` context and truncates to half of `max_length`; with `max_length=448`, effective hotword budget is about 223 tokens before truncation. [E2]
- This means very long lists will silently lose tail entries, so list prioritization/ranking matters. [E2][E4]

### 3) Real-world reports from faster-whisper upstream

- PR #731 reports practical gains on domain terms (e.g., "comfyUI" corrected from repeated misrecognitions). [E4]
- Same thread contains reports of occasional hallucination-side effects or altered segmentation/timestamps under some workloads. [E5]
- Additional user reports mention quality drop for long hotword lists; consistent with code-level truncation. [E4][E2]

## Industry Patterns (How Mature ASR Systems Handle This)

- Google Speech adaptation uses PhraseSets/CustomClass and optional boost, with explicit warning that stronger bias can increase false positives. [E6]
- Azure phrase list is described as just-in-time and lightweight, supports weighting, and recommends custom models for very large lists; phrase list guidance includes practical cap guidance. [E7]
- AWS Transcribe provides custom vocabulary for domain terms and gives concrete file/entry limits plus explicit privacy caution not to upload sensitive data into vocabulary artifacts. [E8]

Implication for Murmur: list-based adaptation is standard industry practice, but bounded lists + tunable strength + privacy guardrails are table stakes. [E6][E7][E8]

## Option Analysis

### Option A: Hotword biasing only (recommended v1)

- Pros: minimal architecture change; aligns with available faster-whisper primitive; no model retraining cycle. [E1][E2][C1][C5]
- Cons: probabilistic, not deterministic; long lists degrade due to prompt budget; potential false-positive/hallucination pressure. [E2][E4][E5][E6]

### Option B: Deterministic post-processing map only (`wrong -> right`)

- Pros: predictable behavior, easy to test and rollback in app pipeline. [C9][C10]
- Cons: can over-correct in unrelated contexts (false replacements), requires curated rule maintenance. [E6]

### Option C: Fine-tuning / custom model

- Pros: can materially improve domain adaptation when enough labeled data exists. [E10][E9]
- Cons: operationally heavier (data, training, model hosting/updates, eval lifecycle), and likely overkill for first release. [E10]

## Recommended Technical Direction

### v1 Design (bias-only)

1. Add `customWords: string[]` in app settings model and persist in existing settings store. [C6]
2. Extend start frame with optional vocabulary payload (prefer `hotwords` string for direct backend use). [C1][C2][C3]
3. Store per-session hotwords in server session context and thread into both partial/final transcription calls. [C4][C5]
4. Pass `hotwords` into faster-whisper transcribe call. [E1][E2][C5]
5. Enforce normalization + constraints before send: trim, dedupe, stable order, and a hard cap to stay within practical token budget. [E2]

### Guardrails (required)

- Limit total serialized hotword length and count to reduce truncation risk and latency increase. [E2][E4]
- Add privacy warning in UX/docs: do not store secrets/PII/PHI in custom words. [E8]
- Add kill-switch in settings to disable vocabulary bias quickly if regressions occur. [E6][E7]

## Evaluation Plan (with measurable thresholds)

### Metrics

- `WER` (primary global quality metric). [E11]
- `Term Recall@Exact` for curated custom-word set (primary feature metric), consistent with phrase-specific adaptation goals in cloud ASR systems. [E6][E7][E8]
- `False Insert Rate` of custom words when absent in reference (safety metric), aligned with biasing false-positive risk guidance. [E6]
- P50/P95 inference time deltas for partial/final outputs (performance metric), motivated by additional prompt processing and known runtime sensitivity to decoding settings. [E2][E4]

### Data

- Curated in-domain test set: 200-500 utterances containing target terms + confusable negatives (to mirror adaptation use-cases focused on confusable terms). [E6][E7]
- Generic regression set (e.g., LibriSpeech test slices) to monitor non-target degradation. [E12]

### Experiment Matrix

- Baseline (no hotwords). [E1]
- Top-20, Top-50, Top-100 custom word sets (to detect truncation knee-point). [E2][E4]
- Priority ordering strategies (frequency-based vs recency-based) to manage prompt budget. [E2]
- Optional: with/without lightweight replacement rules. [C9]

### v1 Success Criteria

- >= 20% relative lift in `Term Recall@Exact` (feature objective based on adaptation intent). [E6][E7]
- <= 1.0 absolute WER regression on generic set (global quality guardrail). [E11][E12]
- <= 10% increase in P95 final inference time (performance guardrail). [E2][E4]
- No significant rise in false insertions of biased terms (safety guardrail for over-bias). [E6]

## Open Questions That Need Empirical Answering

1. Optimal list size before diminishing returns for Murmur audio profile and model sizes. [E2][E4]
2. Whether acronym-heavy lists need formatting heuristics (e.g., `IPC` vs `I P C`). [E6][E7]
3. Whether language-specific lists are needed for multilingual usage. [E9]
4. Whether deterministic replacements are needed after bias-only v1, or if recall gains are sufficient. [C9][E11]

## References

### Codebase References

- [C1] `app/src/shared/protocol.ts:4` (`ControlFrameStart` fields)
- [C2] `app/src/main/services/transcription.ts:66` (`sendStartFrame` payload)
- [C3] `server/src/protocol/frames.py:20` (`StartFrame` schema)
- [C4] `server/src/websocket/handler.py:159` (store start config in session context)
- [C5] `server/src/transcription/engine.py:67` (current transcribe call)
- [C6] `app/src/shared/types.ts:96` (`Settings` type, no custom words)
- [C7] `server/uv.lock:257` (`faster-whisper==1.2.1`)
- [C8] `server/uv.lock:199` (`ctranslate2==4.6.3`)
- [C9] `app/src/main/services/pipeline.ts:41` (post-processing architecture)
- [C10] `app/src/main/services/history.ts:37` (history schema, editable text fields)

### External References

- [E1] faster-whisper README + API entry points: https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md
- [E2] faster-whisper `transcribe.py` (`hotwords`, prompt building, truncation logic): https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py#L1532
- [E3] OpenAI Whisper `transcribe.py` docs (`initial_prompt`, `carry_initial_prompt`): https://raw.githubusercontent.com/openai/whisper/main/whisper/transcribe.py
- [E4] faster-whisper PR #731 (rationale, examples, long-form issues): https://github.com/SYSTRAN/faster-whisper/pull/731
- [E5] faster-whisper PR #731 comments on hallucination/side effects: https://github.com/SYSTRAN/faster-whisper/pull/731#issuecomment-1986870368
- [E6] Google Speech-to-Text model adaptation (PhraseSet/boost/false positives): https://cloud.google.com/speech-to-text/docs/adaptation-model
- [E7] Azure Speech phrase list guidance (just-in-time, weighting, limits): https://learn.microsoft.com/en-us/azure/ai-services/speech-service/improve-accuracy-phrase-list
- [E8] AWS Transcribe custom vocabulary (limits + privacy warning): https://docs.aws.amazon.com/transcribe/latest/dg/custom-vocabulary.html
- [E9] Whisper paper (680k hours, multilingual robustness): https://arxiv.org/abs/2212.04356
- [E10] Hugging Face Whisper fine-tuning guide (operational cost/flow): https://huggingface.co/blog/fine-tune-whisper
- [E11] WER metric definition and formula: https://huggingface.co/spaces/evaluate-metric/wer/blob/main/README.md
- [E12] LibriSpeech corpus details (1000h benchmark corpus): https://www.openslr.org/12
