# Physical microphone validation protocol

Use this protocol for B4 quality, latency, and release evidence. The offline
`scripts/validation_harness.py` scores operator-created files; it does not open
a microphone, launch Eve, or enable telemetry. See the
[baseline report](../architecture/eve-b4-validation-baseline.md).

## Privacy and consent

Use only fictional speech and isolated synthetic profiles. Never inspect daily
History, recordings, clipboard contents, settings, or personal profiles. Close
daily Eve before QA. Use an empty test editor and deliberately seeded synthetic
clipboard. Keep speaker identities, audio, reference/output text, profiles, raw
traces, and trial files outside the repository. Commit reviewed aggregate counts
and durations only, without machine identifiers or user paths. Agree a retention
deadline with each speaker and delete withdrawn trials.

Before **every capture**, explain the card, microphone, duration, start/stop action,
storage, and purpose, then wait for explicit affirmative agreement. Equipment
availability and consent to a previous trial do not authorize another capture.

Suggested notice: “Please read card [ID] through [microphone] in [condition]. After
you agree, you will start Eve manually and stop after reading. Eve processes audio
locally and stores test text in isolated QA History and the test editor. [State
whether a separate audio recording is saved, its local folder, and retention
period.] We publish only reviewed aggregate results. You may stop or withdraw
this trial. May we begin?”

Normal Eve dictation streams audio to its server; this protocol adds no WAV
recorder. Optional audio retention for replay needs separate notice and agreement
for the recording mechanism. Never capture silently, automatically, or in the
background. Explain silence trials too: they capture ambient audio. The second
speaker must give their own agreement.

## Isolated candidate setup

Packaging requires existing release authorization. Use an authorized source-matched
candidate and record source commit and SHA-256 artifact identity before testing.
A trunk commit alone is not an artifact identity. From Windows PowerShell, with
daily Eve closed:

```powershell
# This parent must exist; use a new folder for each clean-profile run.
New-Item -ItemType Directory -Path E:\EveValidation\candidate01 -Force
$qaRoot = 'E:\EveValidation\candidate01\Eve'
# Replace the placeholder with the verified executable.
& 'E:\authorized-candidate\Eve.exe' --eve-qa-isolation "--eve-qa-user-data-root=$qaRoot"
```

The QA root must be absolute, canonical, end in `Eve`, and have an existing
parent. Use both supported QA switches. Malformed QA arguments and simultaneous
`--user-data-dir` fail closed. Stop if isolation fails; never fall back to daily
defaults. See `app/src/main/qa-profile-isolation.ts` and its tests.

Prepare models in this isolated environment through existing controls. Preserve
saved choices/defaults. Record requested/effective model, device, compute, language,
beam/VAD/partial/thread settings, optional pack and model revision/manifest identity.
Record Windows build, CPU/RAM, GPU/driver, sanitized mic category/model, warm-up,
background load, corpus revision, and scoring policy. Do not inspect daily data.

## Fixed script cards

Names and situations are fictional. Save exact reference text externally and
compute word/character counts with the scorer.

| ID | Domain | Read aloud |
| --- | --- | --- |
| Q1 | General | Please send the finalized architecture proposal and meeting summary to the engineering team before five o'clock today. |
| Q2 | Names | Schedule a technical discussion with Priya Sharma and Aarav Patel regarding the Bengaluru and Hyderabad office migration. |
| Q3 | Numbers, dates, amounts | The invoice dated March 18, 2026 for 45,000 rupees has been approved with a 12.5% service discount on reference 849201. |
| Q4 | Technical | Verify the WebSocket connection to the FastAPI server, the Electron and Svelte interface, and the CTranslate2 inference settings. |
| L1 | Sustained | Our fictional team is planning a community library. Priya Sharma will prepare the schedule, and Aarav Patel will review the budget. The first meeting is on March 18, 2026. We have reserved 45,000 rupees for books and equipment, with a 12.5% discount from the supplier. The reference number is 849201. Please check the dates, amounts, and names before sharing the plan. The technical demonstration uses FastAPI, WebSocket, Electron, Svelte, and CTranslate2. We will record decisions in a short report and confirm the next meeting after everyone has reviewed it. |

For Long trials, read Q1–Q4 followed by L1 in fixed order; extend with predetermined
repetitions to reach declared duration. Do not improvise private content. For soak,
use the same sequence and record repetitions/duration. Keep Quick/Long corpus
identities separate.

## Coverage and execution

Available: laptop mic and headset, an Indian English speaker and another speaker.
Identify headset connection type and additional accent without personal names.
Availability is not passing evidence. Mark other equipment, accents, and
representative CPU machines unavailable/pending.

Run each speaker across laptop/headset × quiet/moderate noise × Quick/Long. Use
stable placement/gain and repeatable non-sensitive noise sources such as a fan,
never private conversation. If no meter is available, record noise as unmeasured.
Record actual background load, not just an inferred idle label.

1. Create trial ID and record artifact/configuration/corpus/conditions.
2. Explain and obtain agreement. Perform one excluded warm-up per comparable
   configuration with the same consent procedure.
3. Focus the empty isolated editor, manually start, read, and manually stop Eve.
   Observe delivery and insertion; keep test output externally. Paste request
   completion is not proof of insertion.
4. Record every failure/empty outcome. Missing stages are `null`. CPU/RAM records
   must name sampling interval and process versus whole-machine convention;
   do not claim unsampled peaks.
5. Allocate at least 20 measured trials per comparable reporting stratum for
   descriptive p95. Declare allocation before testing; report small strata as
   insufficient instead of combining incompatible trials.

Test separately, with notice: 5–10 second silence; immediate stop/empty result;
microphone disabled/unavailable; supported headset disconnection mid-capture;
reconnect and successful next trial. Separate expected handled failures from
unexpected failures. Do not pool edge cases into ordinary speech latency. Mark
unsupported physical cases unavailable.

## Scoring and timing rules

WER = word edit distance / reference words; CER = character edit distance /
reference characters. Report pooled counts/denominators and scored sample counts.
Empty reference has no denominator; unscored is unavailable, never perfect.
Keep raw/normalized scores separate with a fixed normalization policy. Do not
silently equate digits and spoken numbers. Human review may document formatting
equivalence and critical entity errors; publish fixed codes/counts, not text.

Report empty results among expected-speech trials and unexpected failures among
all attempted measured trials, with denominators. Assess silence separately.
Do not drop failed trials from coverage.

Nearest-rank percentile is sorted observation at one-based index `ceil(p*n/100)`.
State n per stage; p50 is nearest-rank rather than mean of middle samples. Exclude
warm-ups. Separate hardware/configuration, mic/conditions, corpus, evidence source,
mode, speaker, duration, and edge strata.

Use monotonic durations within one process or external observer, with exact
start/end boundaries and clock domains. Never subtract cross-process timestamps.
First partial starts at capture start; stop-to-final starts at observer stop and
ends at final receipt by that observer. Final-to-History ends when save returns;
clipboard completion ends when write returns; actual insertion ends when the
isolated editor observes expected test text. DOM commit differs from paint;
server send completion differs from receipt. Unobserved stages stay unavailable.
Use the [B4 timing definitions](../architecture/eve-b4-timing-definitions.md) for
runtime events; do not estimate unobserved stages by subtraction.

## Offline commands and result format

Run from the repository root in Windows PowerShell using external QA files:

```powershell
python scripts/validation_harness.py score --reference-file E:\EveValidation\reference.txt --hypothesis-file E:\EveValidation\output.txt
python scripts/validation_harness.py validate E:\EveValidation\results.ndjson
python scripts/validation_harness.py aggregate E:\EveValidation\results.ndjson --format markdown
python scripts/validation_harness.py aggregate E:\EveValidation\results.ndjson --strict-single-stratum
python scripts/validation_harness.py demo
python scripts/validation_harness.py template | Set-Content -Encoding utf8 E:\EveValidation\template.json
python scripts/validation_harness.py baseline
```

The harness defines versioned safe fields. Synthetic demo is schema proof with
zero product measurements. Review aggregates for privacy before committing.
Baseline reports must state exact artifact, coverage, sample counts, observed
results, unavailable stages, and acceptance gaps. Physical/candidate evidence
remains pending until operator tests are performed.

The `template` command emits an explicitly synthetic, unscored JSON example with
all timing/resource values unavailable. Replace fixture identifiers with actual
artifact/environment/trial facts before use; never treat the template as a trial.
Store individual objects, a JSON array, or NDJSON externally as UTF-8; an optional
UTF-8 BOM from Windows PowerShell is accepted.

| Schema section | Required evidence |
| --- | --- |
| `build_info` | Full source commit, artifact name and full SHA-256, clean-tree state |
| `environment` | Windows build, CPU/RAM, GPU/driver, mic category/model, noise and load |
| `configuration` | Requested/effective model/device/compute, partials, mode, beam, language |
| `trial_metadata` | Corpus/speaker/domain/edge identity, warm-up flag/policy, repetitions, duration, physical/replay/synthetic evidence source |
| `stage_timings` | Clock convention, measurement policy, nullable observed milliseconds |
| `resources` | Sampled server/app RSS, CPU convention, optional whole-device VRAM delta |
| `evaluation` | Expected speech, empty/outcome, scoring identity/counts/rates, human code and critical errors |

Maintain an external, sanitized manifest for each policy ID. `runtime_settings_id`
identifies exact VAD/thread/partial settings, model revision, and optional runtime
pack identity; `background_load_id` identifies active workload and load procedure;
`measurement_policy_id` identifies each stage's clock domain, start/end boundaries,
observer, and resource sampling interval/convention. Use different IDs whenever
these facts differ. Timing values are durations, not wall-clock timestamps; do
not use the illustrative `monotonic_ms` convention as a common cross-process clock.
Fields such as stop request, last audio, and VAD markers remain null until their
offset origin is explicitly defined and observed in the measurement manifest.

`standard` scoring lowercases, replaces punctuation with spaces, and collapses
whitespace. WER tokenizes on whitespace. CER excludes whitespace in both raw and
standard scoring; raw preserves remaining case and punctuation. Numbers are not
converted. Use `score --raw` for the separate raw result. Copy only numeric counts,
rates, and normalization identity into the record. For human-only review, keep
score fields null and use the fixed assessment code. False-perfect unscored rates
and unknown schema fields are rejected.
