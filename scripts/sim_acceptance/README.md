# Simulated Windows acceptance

Use this lane for a verified Eve 0.9.0-beta.1 bundle retained by the installer
lifecycle workflow. The workflow downloads the original zip, verifies provenance,
phase status, expected manifest and each staged file, then verifies the installed
payload. The job uses a read-only token on GitHub-hosted Windows.

## Hosted CPU

`simulated-acceptance.yml` offers a one-clip disposable desktop smoke and a
four-job matrix. Same-repository pull requests targeting trunk run the smoke
when this workflow or its harness changes. Apply the sim-full label once the
smoke passes to run the full matrix. Keep the lane off the required checks.

Run ID `45784796424`, artifact ID `15101085356`, commit
`22aa01d70a10fc8b52668866ff1c0bd5ac02c751` and manifest SHA-256
`e0004b05ee119467a037c201ea723159e01adda3615f5a2668cfb05433fe763f` are the
pull request defaults. That candidate expires on 2026-12-03 at 08:50 UTC and can
omit paste readiness or retry once after a pre-dispatch paste skip. Other
candidates must report settled paste readiness and must insert on the first
attempt in smoke mode.

For a new candidate, dispatch `installer-lifecycle-ci.yml` on `trunk` with
`expected_commit` set to the full trunk commit and `retain_candidate=true`.
After that run succeeds, use its retained artifact to dispatch the full matrix
on `trunk` from Windows PowerShell.

```powershell
@{
  candidate_run_id = '<successful lifecycle run ID>'
  artifact_id = '<ID of eve-v0.9.0-beta.1-unsigned-candidate-qa-RUN_ID>'
  candidate_commit = '<40-character commit SHA from the lifecycle run>'
  manifest_sha256 = '<SHA-256 of eve-v0.9.0-beta.1-artifact-manifest.json>'
  smoke_only = $false
} | ConvertTo-Json -Compress | gh workflow run simulated-acceptance.yml --ref trunk --json
```

Each CPU job uses `small` and an isolated candidate profile
and Hugging Face cache. The launch includes Chromium's fake audio capture
flags and a non-looping file. Eve opens its normal audio worklet with packaged
media processing enabled. The noise mix SNR applies at the WAV input.

The desktop fixture observes two delivered F9 or F10 key-downs and actual
text editing in the same editor and monotonic clock. The second key is the
stop. The fixture observes the clipboard after the paste restore window.
Scored trials enable paste and restoration with auto-copy disabled, because
the candidate retains the dictated text on the clipboard when auto-copy is
enabled. An isolated native Ctrl+V control checks the runner/editor path.
Evidence retains counts, timings, hashes and scores. Performance marks use
Eve's main clock for stop-to-final and for paste helper diagnostics. The
completed trace's allowlisted `paste_pre_dispatch_reason` is retained in
smoke evidence when the candidate provides it. For the
GPU latency estimate the scorer adds the largest observed close/quiet
stop-to-insert minus main stop-to-final interval per mode. This subtraction
uses durations and includes hotkey delivery and observer timing. Full GPU
editor latency remains open.

The warm-up exercises actual desktop focus, global hotkeys, fake microphone,
model output, History and Win32 paste. If the hosted desktop cannot establish
this chain, the CPU fallback streams the same WAVs to the bundled verified
server at real-time speed. This yields replay-only stop-to-final, accuracy and
server resource observations. Editor insertion, clipboard, app-side timing
and resources remain open on the fallback.
Replay uses a different audio and finalization path, so its timings are
diagnostic and leave the frozen stop-to-editor rows open.

The first observed final is scored. Insertion, clipboard restoration and
History are checked independently. Confirmed empty output counts as all
deletions. The table reports scored and attempted totals and keeps a limit open
when missing observations could change the verdict. Percentiles use nearest
rank with the sample count beside each estimate. GPU timing proxies and Long
transcript heuristics appear below the frozen gate table.

RSS uses the owned app tree's working set, including the verified managed
server PID. Sampling targets one second, permits at most 2.5 seconds between
samples and validates each window boundary within two seconds. Sampler errors
leave coverage unverified. Idle CPU uses same-process-set interval deltas
across two minutes. Cancellation records the quit request and app exit path.

## Local headless CUDA

Use Windows PowerShell and a detached clean worktree at the candidate SHA.
Prepare the server with `uv sync --python 3.11 --extra whisper --group dev --frozen`
in that worktree. The harness also needs the pinned packages in
`scripts/sim_acceptance/requirements.txt`. Use an explicit external scratch
directory for the corpus, cache, model, PID file, settings, logs and output.
Never route this command through the packaged Eve app.

From the harness checkout, run
`python scripts/sim_acceptance/prepare_corpus.py --root <corpus-dir> --config gpu-close-quiet`.
Run the candidate's `server/src/main.py` with the dev Python executable,
headless, using localhost and `MURMUR_PORT=0`. Set `HF_HOME` and
`HF_HUB_CACHE` to the isolated cache, `MURMUR_SETTINGS_FILE` and
`MURMUR_PID_FILE` to scratch files, `MURMUR_PERF_TRACE=1`,
`MURMUR_WHISPER_MODEL=large-v3-turbo` and `MURMUR_WHISPER_DEVICE=cuda`.
Use the installed CUDA Toolkit through the dev environment. Clear
`MURMUR_GPU_RUNTIME_DIR` and `MURMUR_GPU_PACK_ID` if present in that
shell. The replay checks the exact source commit, ready CUDA and model health,
RTX 3060 Laptop and absence of a managed GPU pack.

For a new candidate, use the same four verified pins as the hosted dispatch and
offline scorer. Omit `--candidate` to use the original retained candidate.

```powershell
python scripts/sim_acceptance/replay.py --source '<candidate-worktree>' `
  --pid-file '<scratch-pid-file>' --manifest '<corpus-manifest>' --output gpu-evidence.json `
  --candidate '<lifecycle run ID>' '<artifact ID>' '<commit SHA>' '<manifest SHA-256>'
```

## Offline scoring

Use `score.py --output <report.md> <cpu/gpu evidence files>` to
render the frozen gate table for the original candidate. For a new candidate,
pass the same four pins you supplied to the hosted dispatch. Every evidence
file must match the full tuple.

```powershell
python scripts/sim_acceptance/score.py --output acceptance.md `
  --candidate '<lifecycle run ID>' '<artifact ID>' '<commit SHA>' '<manifest SHA-256>' `
  .\far-quiet\evidence.json .\far-moderate\evidence.json `
  .\close-moderate\evidence.json .\close-quiet\evidence.json
```

Include `gpu-evidence.json` as another input if you ran the local CUDA replay
with those pins.

Exit codes are 0 for all rows passed, 1 for at least one failure and 2 for
open rows with no observed failure. To verify G2,
supply `--lifecycle-run`, `--history-run`, `--history-evidence` pointing to
the original History artifact ZIP, and `--history-metadata` pointing to the
GitHub artifact API response. The scorer checks the ZIP digest and run linkage.
The main evidence JSON contains sanitized observations. Keep audio, full references
and hypotheses, History databases, model caches and raw diagnostics in scratch.

## Supplemental entity audit

The opt-in `--entity-audit` replay output applies Whisper's English
normalizer to both reference and output for WER and exact entity alignment.
The full hosted matrix also collects this audit. Its uploaded sidecar holds
scores, hashes, clip IDs and reference entity indexes. Compare any raw model
spans in scratch. Ordinary acceptance uses the frozen normalization. Review rare-name
spelling variants separately before calculating the supplementary
genuine-error-only score.

## Coverage limits

The simulation cannot establish real microphone acoustics, drivers, hardware
unplug, human hotkey timing, accent coverage, actual third-party application
paste, or installed GPU pack behavior. The current hosted harness covers model
download interruption via managed server termination. A physical network
interruption and trusted certificate path across Wi-Fi recovery, corrupt model
and GPU pack fixtures, and physical USB microphone recovery require their own
observations. Each such row remains open until evidence is recorded.

See [corpora and attribution](CORPORA.md) and the
[frozen plan](../../docs/architecture/eve-beta1-release-plan.md).
