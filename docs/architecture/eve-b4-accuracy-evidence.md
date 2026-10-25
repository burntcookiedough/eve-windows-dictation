# Eve B4 accuracy evidence and comparable scoring

B4 evaluation requires comparable accuracy measurements between baseline and candidate
artifacts across identical public reference and hypothesis pairs. This document
defines the scoring policy, records the audit of historical Attempt 5 evidence,
documents the deterministic edit-decomposition helper (S/D/I), and establishes the
safe aggregate sidecar schema for future controlled replays.

> **Status: Accuracy acceptance is INCOMPLETE.** B4 remains open. Source-only repairs,
> offline unit tests, and synthetic examples do NOT constitute task accuracy acceptance
> or a completed B4 quality gate.

## Historical Attempt 5 audit and evidence availability

The original local-candidate Attempt 5 replay (60 total trials: 20 warm-up, 40 measured
across 10 LibriSpeech speaker strata, 4 measured trials per stratum) was audited
independently.

| Metric / Dimension | Attempt 5 availability | Reason / Finding |
| --- | --- | --- |
| Raw safe aggregate records | 60 records available | Stored externally in `qa/sandbox-output-replay-attempt5/` |
| Observed trial hypotheses | **UNAVAILABLE** | Ephemeral only; no hypothesis text persisted anywhere |
| Server log text | **UNAVAILABLE** | Recorded character counts and stage timings only |
| Windows Sandbox guest | **CLOSED** | Disposable VM terminated after exports verified |
| Standard normalized WER/CER | **UNAVAILABLE** | Cannot compute normalized metrics without output text |
| S / D / I error decompositions | **UNAVAILABLE** | Cannot compute edit paths without output text |
| Critical entity review | **UNAVAILABLE** | Recorded as null; no human review was conducted |

### Critical audit findings

1. **No output text was retained.** In compliance with repository privacy boundaries,
   neither the replay runner nor the server persisted transcript strings.
2. **Normalized metrics cannot be mathematically reconstructed from raw totals.**
   Raw case-sensitive WER was 93.2%-100% due to uppercase LibriSpeech references.
   It is impossible to deduce which errors were case/punctuation differences versus
   lexical substitutions without the original hypothesis strings.
3. **No quality pass or reconstructed metrics may be claimed.** Fabricating or
   inferring normalized accuracy numbers from historical raw aggregates is strictly
   prohibited.
4. **New controlled public replay is required.** Live comparable accuracy evidence
   can only be obtained by running a new controlled replay with the updated observer seam.
5. **All historical evidence remains untouched.** Historical trial evidence stored in
   `qa/sandbox-output-replay-attempt5/` is immutable and unmodified.

## Pinned normalization and scoring policy

Comparable accuracy scoring preserves existing repository policies while extending
transient in-memory evaluation to produce both raw and standard metrics on identical
speech receipts.

### Normalization transform

The standard normalization policy is pinned to `scripts.validation_harness.normalize_text`:
`WHITESPACE_REGEX.sub(" ", PUNCT_REGEX.sub(" ", text.lower())).strip()`
1. Convert all characters to lowercase via `text.lower()`.
2. Replace all punctuation characters using `PUNCT_REGEX = re.compile(r"[^\w\s]")`
   with ASCII spaces. `[^\w\s]` matches every character that is neither an
   alphanumeric/underscore word character (`\w`) nor a whitespace character (`\s`).
3. Collapse consecutive whitespace sequences using `WHITESPACE_REGEX = re.compile(r"\s+")`
   into a single ASCII space and strip leading and trailing whitespace.

Under `--raw` scoring, outer whitespace is stripped (`text.strip()`), but case and
punctuation are preserved without modification.

### Denominators and error definitions

- **Word error rate (WER):** Computed on whitespace-delimited tokens.
  `WER = (Substitutions + Deletions + Insertions) / Reference Word Count`.
  Metric truth is defined by `scripts.validation_harness.compute_wer`.
- **Character error rate (CER):** Computed on non-whitespace characters.
  `CER = (Substitutions + Deletions + Insertions) / Reference Character Count`.
  Metric truth is defined by `scripts.validation_harness.compute_cer`.
- **Empty reference policy:** If reference text contains no words (or characters),
  error count is 0 and rate is `None` (`"unavailable"`).
- **Unexpected failures:** When a request fails, times out, raises an error, or
  returns `outcome != "success"` (including `text is None`), the trial counts in
  `unexpected_failures` and remains in the trial denominator (`measured_trials`).
  Failure counting is evaluated independently of observed empty output. If text is
  present, available text is still scored as `make_record` does. `None` is never
  treated as observed empty.
- **Observed empty outputs (`""` or whitespace):** When a final response is received
  with text delivered (not `None`) but contains only whitespace, `output_empty` is `True`
  and increments `observed_empty_count`. All reference words/characters are scored
  as **deletions** (S=0, D=RefUnits, I=0).

### Deterministic edit-decomposition (S / D / I)

The helper `scripts.accuracy_scoring.decompose_levenshtein` decomposes edit distance
into substitutions ($S$), deletions ($D$), and insertions ($I$) while ensuring:

$$\text{Total Errors} = S + D + I = \text{Levenshtein Distance}$$

- **Deterministic tie-break order:** When multiple edit paths yield the identical
  minimal distance, the algorithm resolves ties with the following preference order:
  1. **Match / Substitution** (diagonal transition)
  2. **Deletion** (vertical transition: present in reference, absent in hypothesis)
  3. **Insertion** (horizontal transition: absent in reference, present in hypothesis)
- **Memory complexity:** Implemented with a single rolling dynamic programming row
  ($O(N)$ space, where $N$ is hypothesis length), preventing quadratic memory
  allocations during long-form dictation.

### Critical entity human review

Automated phrase heuristics must not be substituted for human assessment. No API
or ingestion mechanism exists in the benchmark runner or accuracy accumulator
to ingest human review counts. Consequently:
- Critical entity human review remains **unavailable**.
- `critical_entity_review_availability` is fixed to `False`.
- `critical_entity_errors` remains `None` (null).

## Reproduction and execution commands

All commands must be executed from Windows PowerShell within the repository.

The optional sidecar starts as an explicitly incomplete report. The complete
aggregate is written to an exclusive temporary file in the same directory,
flushed and synchronized, then atomically replaces that placeholder. Report I/O
failure or interruption leaves the placeholder incomplete and preserves primary
trial records; temporary-file cleanup runs on normal exception paths.

### Replay with safe aggregate sidecar

```powershell
# Replay external public test corpus, writing safe ndjson records and optional accuracy sidecar
python scripts/perf_regression_benchmark.py replay `
    --manifest <path/to/manifest.json> `
    --output <path/to/trials.ndjson> `
    --accuracy-output <path/to/accuracy-summary.json> `
    --repetitions 2 `
    --url ws://127.0.0.1:51717/transcribe
```

### Raw mode replay with safe aggregate sidecar

```powershell
python scripts/perf_regression_benchmark.py replay `
    --manifest <path/to/manifest.json> `
    --output <path/to/trials.ndjson> `
    --raw `
    --accuracy-output <path/to/accuracy-summary.json> `
    --repetitions 2 `
    --url ws://127.0.0.1:51717/transcribe
```

### Predeclared before/after regression comparison

```powershell
python scripts/perf_regression_benchmark.py compare `
    --before <path/to/baseline.ndjson> `
    --after <path/to/candidate.ndjson> `
    --thresholds <path/to/thresholds.json>
```

### Verification tests

```powershell
Set-Location server
uv sync --extra whisper --group dev --frozen
uv run pytest tests/test_accuracy_scoring.py tests/test_perf_regression_benchmark.py tests/test_validation_harness.py
```

## Synthetic demonstration examples

> **Notice:** The examples below are synthetic unit test fixtures used to verify
> algorithm correctness. They are NOT live replay results or acceptance benchmarks.

### Example 1: Normalization effect on case and punctuation

- **Reference:** `"The quick, brown fox jumps over the lazy dog."`
- **Observed:** `"the quick brown fox jumps over the lazy dog"`

| Mode | Scored Reference Words | Substitutions | Deletions | Insertions | Total Errors | WER |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Raw** | 9 | 3 | 0 | 0 | 3 | 33.3% |
| **Standard** | 9 | 0 | 0 | 0 | 0 | **0.0%** |

### Example 2: S / D / I error decomposition verification

| Reference Text | Hypothesis Text | Mode | Ref Words | S | D | I | Total Errors | WER |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `"one two three"` | `"one four three"` | Standard | 3 | 1 | 0 | 0 | 1 | 33.3% |
| `"one two three"` | `"one three"` | Standard | 3 | 0 | 1 | 0 | 1 | 33.3% |
| `"one three"` | `"one two three"` | Standard | 2 | 0 | 0 | 1 | 1 | 50.0% |
| `"repeat phrase"` | `"repeat phrase repeat phrase"` | Standard | 2 | 0 | 0 | 2 | 2 | 100.0% |
| `"delivered text"` | `""` (empty) | Standard | 2 | 0 | 2 | 0 | 2 | 100.0% |
