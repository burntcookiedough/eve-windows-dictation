# B4 timing boundaries and regression benchmark

Instrumentation is opt-in with `MURMUR_PERF_TRACE=1`. It must retain only bounded,
content-free events and must not change model choice, user settings, partials,
auto-stop, cancellation, final delivery, clipboard restoration, or Long memory
bounds. See the [shared protocol](../development/microphone-validation-protocol.md)
and [baseline](eve-b4-validation-baseline.md). B4 physical/candidate evidence is
still **n = 0**; there is no measured implementation speedup.

## Clock and stage definitions

Electron main `performance.now()`, overlay renderer `performance.now()`, editor
renderer `performance.now()`, replay observer `time.perf_counter()`, and server
`time.perf_counter()` are separate clock domains, even on one machine. Correlation
IDs join events; they do not synchronize clocks. Calculate durations only within
a domain and record observer/boundaries. Never estimate network transit by
subtracting a sum of internal spans. Missing observations are null, not zero.

| Stage | Boundary and evidence |
| --- | --- |
| Stop / last audio | Main stop entry and last dispatched frame; separately overlay stop/capture/last-frame markers. A dispatched frame is not proof the server accepted it. |
| First partial | First partial receipt minus capture/stream start, within that observer. Never use a renderer start with a main receipt. |
| Outstanding work | State of outstanding partial at stop plus measured global lock and executor queue waits. Global lock wait cannot be assigned wholly to one session's partial. Unknown attribution stays unavailable. |
| Final inference | Worker entry through completed transcription, including lazy segment iteration and any instrumented retry. Long chunk totals are sums of observed spans, not a single contiguous inference interval. |
| Final WebSocket send | Server ASGI send start through awaited send completion. This measures transport handoff, not client receipt. Send completion cannot be included in the frame being sent; use the server-side trace. |
| Receipt / display | Main final receipt; separately overlay final receipt through Svelte DOM commit after tick. DOM commit does not establish paint. |
| History | Final receipt through save completion within main, plus save call duration separately. History follows clipboard/paste in the existing pipeline. |
| Clipboard | Native write start through return, plus final receipt through write completion within main where observed. Paste helper completion is separate. |
| Actual insertion | Verified insertion into the explicitly isolated editor after a trusted input event and value change. Beforeinput, delete, unchanged value, key request, or paste promise are insufficient. Editor timestamps cannot be subtracted from main stop. |

The wired runtime is covered by default-wire, correlated-session, lock/executor,
lifecycle, privacy, and editor tests. `final_inference_start_offset_ms` and
`final_inference_end_offset_ms` are worker boundaries relative to the server final
processing entry; the inference duration sums observed completed calls.
`partial_task_active_at_stop` observes the asynchronous partial task, not proof
that cancelled native work stopped. `outstanding_partial_wait_ms` stays null
because lock contention cannot safely attribute that delay. Only tested
boundaries may be reported as observed; tests do not establish product timings. The isolated editor's local insertion span
and a whole stop-to-insertion measurement are different results. When one observer
cannot observe both boundaries, whole insertion latency remains unavailable.

## Opt-in diagnostics and isolated editor

Set `$env:MURMUR_PERF_TRACE='1'` before launching an authorized isolated test Eve
and its server; remove the variable after the experiment. No capture starts from
this setting. Preserve the usual capture notice and agreement for every trial.
The start frame carries optional `trace_id`; final `perf.session_id` echoes it.
Main and server log fixed-field `B4_PERF` records only while enabled; retain them
outside the repository. Each process retains at most 50 in-memory records; main
exports at most eight snapshots per trial. Normal wire frames omit diagnostics.
Renderer IPC is accepted only from the overlay and only with the fixed schema.
Later snapshots may include output/DOM stages absent from an earlier snapshot.
Select the latest observed fields by correlation ID within their clock domain.

For the explicit editor, from `app/` run `bun run dev:vite` and open
`http://127.0.0.1:5173/app/fixtures/isolated-editor-observer.html` (use the configured
port if different). Focus its empty textarea before the scripted dictation paste.
It observes only that element; it never reads a clipboard or other window.
A trusted insertion with changed value is observed; typing also counts as insertion,
so confirm the intended paste action and expected script with the operator.
Copy only numeric observations into external evidence. Close/reset between trials.
The automated Electron `insertText` fixture proves DOM filtering, **not** native
Windows paste or physical dictation. Whole stop-to-insertion requires a single
external observer covering both endpoints; otherwise report it unavailable.

## Real-time prerecorded replay

`scripts/perf_regression_benchmark.py replay` streams **explicitly supplied external
WAV files** to a separately started localhost speech server. It never launches
Eve, records a microphone, reads daily data, or downloads a model. Use only
consented scripted recordings or an approved public corpus. Record artifact
identity and verify effective model/settings through existing health/runtime
controls before running; manifest declarations alone are not runtime verification.

Create an external JSON manifest with exactly `record` and `clips`. `record` is a
fully populated shared-schema record from `validation_harness.py template`, with
verified nonzero source/artifact hashes, clean-tree true, `evidence_type: replay`,
and `warmup_policy: one_excluded_per_clip`. `clips` is an ordered array of:

```json
{"audio":"script-Q1.wav","reference":"script-Q1.txt","speaker_stratum":"indian_english_01","content_domain":"general_english"}
```

Paths resolve relative to the external manifest. The runner rejects repository
inputs, linked/reparse paths, remote servers, credentials, and fixture artifact
identities. WAVs must be mono signed 16-bit PCM at 16 kHz. It hashes each WAV and
reference plus clip metadata/order into the corpus ID, so comparisons cannot
silently use different inputs. No filenames, reference text, or recognized text
are printed or written to safe trial records.

From Windows PowerShell, after separately verifying the authorized local server:

```powershell
Set-Location server
uv run --no-sync python ../scripts/perf_regression_benchmark.py replay --manifest E:\EveValidation\replay-manifest.json --output E:\EveValidation\before.ndjson --repetitions 2 --raw
# Repeat using the source-matched after artifact and identical environment/settings.
uv run --no-sync python ../scripts/perf_regression_benchmark.py replay --manifest E:\EveValidation\after-manifest.json --output E:\EveValidation\after.ndjson --repetitions 2 --raw
uv run --no-sync python ../scripts/perf_regression_benchmark.py compare --before E:\EveValidation\before.ndjson --after E:\EveValidation\after.ndjson --thresholds E:\EveValidation\thresholds.json
```

Outputs are created exclusively, never overwritten. One excluded warm-up precedes
measured repetitions **for each clip**. Streaming uses bounded 200 ms PCM frames
at real-time pace; first partial starts at streaming start, stop-to-final starts
immediately before the observer sends stop and ends upon final receipt. Last-audio
metric is the observer's elapsed gap from last frame send to stop. Explicit stop
uses a declared 7,200-second silence timeout; this is a benchmark condition,
not a production settings change or an auto-stop test. A premature final is a
failed comparable trial. Failed/empty trials stay in the denominator.

The runner scores only externally supplied test reference/output in memory and
writes numeric errors/rates. Resource, microphone, Electron display, History,
clipboard, and insertion stages remain unavailable. Server lock/inference spans
may be copied only from a correlated fixed-field trace; their domain stays server.
The schema measurement policy `b4_replay_explicit_stop_v1` maps these fields to
these domains and boundaries. Full server-side send completion is available only
in a separately captured server trace. The runner does not claim GPU/CPU identity
from speed alone.

## Predeclared provisional comparison limits

These limits are **provisional optimization guardrails**, not accepted alpha release
requirements or historical acceptance thresholds. Freeze them, sample allocation,
and environment manifest before any before/after measurement; retain their hash
and timestamp with the external evidence. Recalibration requires a documented
reason before a new experiment, never after seeing an unfavorable result.

Example external `thresholds.json`:

```json
{"minimum_samples":20,"latency_absolute_ms":200,"latency_relative":0.10,"wer_absolute":0.01}
```

| Metric | Provisional regression limit |
| --- | --- |
| Stop-to-final p50/p95 | Neither grows by more than the larger of 200 ms or 10% of its comparable baseline; at least 20 observed samples per stratum per side |
| Pooled raw WER | No increase greater than 1 percentage point; at least 20 scored trials per stratum per side; normalized scores remain separate |
| Empty / unexpected failures | No increase in comparable rates; every attempted trial included |
| Critical names/numbers/dates/amounts/terms | No additional human-reviewed critical errors on paired corpus |
| CPU / RAM | No greater than 10% CPU relative regression under the same sampling convention; sampled peak/settled RSS no increase above the larger of 10% or 100 MiB; inspect thermal/load conditions |
| Partials / auto-stop / cancellation / recovery | Existing regression tests pass and physical paired scenarios show no lost partials, new premature stops, hangs, duplicate outputs, or recovery failures |
| Actual insertion | Expected scripted text is inserted once into the isolated editor; clipboard restoration verified with synthetic seeded data; missing insertion evidence cannot pass |

Comparison matches hardware, corpus, warm-up, load, runtime and measurement policies,
mode, speaker/domain/edge/duration, and scoring identity. Only source/artifact identity
may differ. Multiple incompatible artifacts per side are rejected. It reports
unavailable metrics rather than perfect results. A command exit zero means a
valid comparison report without a measured regression, **not** optimization or
alpha acceptance: CPU/RAM, partial quality, auto-stop, insertion, and physical
coverage still require independent evidence. `optimization_accepted` stays false.

## Current before/after report

| Evidence | Before | After | Acceptance |
| --- | --- | --- | --- |
| Source-matched CPU product p50/p95 | n=0 | n=0 | Pending |
| Shared physical corpus quality / failure / insertion | n=0 | n=0 | Pending |
| Resource / auto-stop / partial quality regression | Unmeasured | Unmeasured | Pending |
| Replay runner mechanics | Local synthetic protocol test | 5 automated runner tests | Software proof only |
| CPU optimization | None evaluated | None applied | No speedup claim |

Historical profiles suggest inference and serialization behind partials dominate,
but cannot select a new code optimization without comparable current measurements.
Next: obtain candidate authorization, verify exact artifacts, run shared corpus
on representative CPUs with declared settings/load/warm-up, profile dominant
spans, and apply only the smallest evidence-supported change. Compare identical
inputs and reject guardrail regressions. Do not use smaller models or disabled
partials as implementation speedups.
