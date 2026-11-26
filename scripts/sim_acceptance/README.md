# Simulated Windows acceptance

Use this lane for the verified Eve 0.9.0-beta.1 bundle retained from lifecycle
run 45784796424, artifact 15101085356. It expires on 2026-12-03 at 08:50 UTC.
The candidate commit, artifact ID, run ID and release manifest SHA-256 are pinned
in the verifier. The workflow downloads the original zip, verifies provenance,
phase status, expected manifest and each staged file, then verifies the installed
payload. The job uses a read-only token on GitHub-hosted Windows.

## Hosted CPU

`simulated-acceptance.yml` offers a one-clip disposable desktop smoke and a
four-job matrix. Same-repository pull requests targeting trunk run the smoke
when this workflow or its harness changes. Apply the sim-full label once the
smoke passes to run the full matrix. Keep the lane off the required checks.
Manual dispatch is also available once the workflow exists on the default branch.

Run ID `45784796424`, artifact ID `15101085356`, commit
`22aa01d70a10fc8b52668866ff1c0bd5ac02c751` and manifest SHA-256
`e0004b05ee119467a037c201ea723159e01adda3615f5a2668cfb05433fe763f` are the
approved inputs. Each CPU job uses `small` and an isolated candidate profile
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
Eve's main clock for stop-to-final and for paste helper diagnostics. For the
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

The first final in a settled session is scored. Attempts that actually return
empty or fail without text count as all deletions. Attempts whose output could
not be observed remain unscored and are visible in the denominator. Percentiles
use nearest rank with the sample count beside each estimate. RSS samples are
working set of the owned app tree including its verified managed server PID.
Idle CPU uses same-process-set interval deltas across two minutes.

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

`python scripts/sim_acceptance/replay.py --source <candidate-worktree> --pid-file <scratch-pid-file> --manifest <corpus-manifest> --output <gpu-evidence.json>`

Use `score.py --output <report.md> <cpu/gpu evidence files>` to
render the frozen gate table. Exit codes are 0 for all rows passed, 1 for at
least one failure and 2 for open rows with no observed failure. The main
evidence JSON contains sanitized observations. Keep audio, full references
and hypotheses, History databases, model caches and raw diagnostics in scratch.

## Supplemental entity audit

The opt-in `--entity-audit` replay output applies Whisper's English
normalizer to both reference and output for WER and exact entity alignment.
The full hosted matrix also collects this audit. Its separate sidecar holds
scores, hashes and short public-corpus entity spans for the misses. Keep
ordinary acceptance evidence under the frozen method. Review rare-name
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
