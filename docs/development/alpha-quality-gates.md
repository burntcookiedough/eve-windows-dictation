# Alpha quality gates and B4 evidence runbook

This is an evidence index for the existing release controls, not authorization or
another release mechanism. **B4 and alpha acceptance remain pending**: current
physical-microphone, source-matched candidate, and CPU before/after product samples
are n=0. Unit tests, skipped lifecycle jobs, historical replay, and one machine
cannot establish alpha readiness or broad hardware support.

Use the [shared microphone protocol](microphone-validation-protocol.md),
[baseline](../architecture/eve-b4-validation-baseline.md), and
[timing/benchmark rules](../architecture/eve-b4-timing-definitions.md). Preserve
Faster-Whisper/CTranslate2, fresh-profile `small`, saved choices, local packaged
processing, separate model downloads, and optional NVIDIA acceleration.

## Existing authority and evidence

The [lean runtime release plan](../architecture/eve-lean-runtime-release-plan.md)
retains CPU distribution, GPU integrity/legal, compatibility and lifecycle gates.
[Building](building.md) and [agent workflow](agent-workflow.md) govern Windows
commands and final integration into trunk. Historical
[Gate 6](../architecture/eve-gate-6-release-plan.md) and
[v0.8 preparation](../architecture/eve-v0.8-release-preparation.md) records remain
frozen; their prior approvals do not authorize a new candidate.

Packaging, signing, installer execution and publication require the applicable
plan and explicit exact-head authorization. This B4 work authorizes none of them.
Do not tag, upload, publish, merge, replace assets, change allowlists, or reuse
historical output. Identify the final reviewed head first; after authorization,
prepare one fresh source-matched nsis-web CPU candidate and compatible optional
GPU component where applicable under the existing plan. Any later source change
invalidates candidate evidence until that exact artifact is verified again.

Keep an external evidence ledger for each gate: gate ID; scenario; exact source
commit and artifact/manifest hashes; hardware/configuration/corpus stratum;
predeclared threshold and its approval status; attempts/observed/scored counts;
result (`pass`, `fail`, `pending`, `unavailable`); reproduction command/procedure;
and privacy-reviewed evidence location. Missing equipment is unavailable, not a
pass. Pending mandatory evidence blocks acceptance. Publish aggregates only.

## Mandatory blockers

These functional and integrity requirements apply now. Numerical quality and
performance acceptance bounds below still need approval before trials; they do
not silently replace existing requirements. Every candidate gate is currently
**pending**, even where source tests pass.

| Gate / scenario | Evidence and threshold | Current result / reproduction |
| --- | --- | --- |
| G1 Exact source, artifact, runtime and CI | Final integration targets trunk; applicable CI passes on final head. Source/version, seven-asset allowlist, manifest hashes, signature policy, bundled isolated runtime and supported family match. Zero identity/hash/runtime mismatch. | Candidate pending. Run commands A/B below; retain CI URLs and exact tested hashes. A build or commit alone is insufficient. |
| G2 Clean install, upgrade, uninstall, rollback | Disposable Windows runner/VM with synthetic QA profiles and verified baseline/candidate. Preserved installer identity, saved settings and synthetic History; no orphan owned processes; rollback restores compatible operation. All four scenarios succeed, no daily profile touched. | Pending. Use existing hosted lifecycle control C when authorized and allowlisted; manual isolated VM procedures follow its assertions if unavailable. Never bypass its host/ref safeguards. |
| G3 Privacy and logging | Every capture has individual notice/agreement, including warm-up and silence. No background recording/telemetry or transcript/clipboard/audio in timing logs. Synthetic canary absent from reviewed logs; no daily data access. | Source privacy tests pass; candidate pending. A plus manual canary trial and opt-out/opt-in log review in isolated QA. Keep raw evidence outside Git. |
| G4 Microphone unavailable/disconnected/recovery | Explicitly selected laptop mic/headset; disabled/unavailable start and supported mid-capture headset unplug are handled visibly without hang/duplicate final. Reconnect then next scripted trial succeeds. Include empty/silence results without hallucinated sensitive output. | Pending. Shared protocol edge trials, each with notice/agreement; record expected handled failures separately from unexpected failures. |
| G5 Server death/restart | Kill only the verified QA-owned server during Quick and Long, including final processing; app recovers visibly, preserves known final/History semantics, prevents duplicate output; next session succeeds after restart. No leaked lease/spool/process. | Source lifecycle tests pass; candidate pending. A then manual owned-process failure/restart; record state transitions and synthetic outputs, not daily processes. |
| G6 Model preparation/failure | Separate model download in clean QA cache; interrupt/fail then retry; missing/corrupt/unavailable model and readiness handled without recording before ready. Successful preparation produces next Quick/Long final. Requested choices retained, effective CPU fallback truthful. | Source readiness/model tests pass; candidate pending. A then existing model preparation UI with isolated cache and controlled failure; compare health/runtime fingerprint. |
| G7 Quick/Long soak and cancellation | Predeclare duration/load/trial allocation. No lost/duplicate finals, hangs, new premature auto-stop, stuck partials or unbounded Long memory. Cancel during acquisition/inference, then next trial succeeds; spool cleaned. | Source Long/cancellation tests pass; candidate pending. Run A then consented shared corpus soak procedure D and sampled resource observations. |
| G8 CPU quality/latency/resources | Repeatable physical corpus on declared representative CPU hardware; exact-artifact p50/p95, WER/CER or reviewed error assessment, empty/failure rates and sampled CPU/RSS recorded. Accepted numerical bounds frozen before evaluation; no guardrail regression. | Pending, n=0. Shared protocol plus benchmark E. Hardware scopes remain separate; no smaller model/default changes counted as speedup. |
| G9 Optional GPU integrity/failure/CPU fallback | Existing pinned pack provenance/legal/manifest checks and compatible runtime fingerprint; corrupt/truncated/wrong-version/interrupted pack handled; pack unavailable or NVIDIA failure yields usable CPU without rewriting requested preferences. Quick/Long on clean NVIDIA host if GPU offered. | Pending. Existing lean-plan controls, GPU tests in A, and authorized isolated pack lifecycle. CPU base includes only retained permitted dispatcher, not bulk NVIDIA/Torch closure. Missing GPU machine does not waive an offered component gate. |
| G10 Physical accuracy and actual insertion | Laptop/headset, quiet/moderate noise, Quick/Long, Indian English/additional speaker, fictional entities and edge coverage. Expected script inserted once in isolated editor; seeded synthetic clipboard restored where configured. Stage sample counts explicit; paste request is insufficient. All attempted trials remain in empty/failure-rate denominators; score empty output as deletions when reference exists. Report unscorable failures separately and scored WER counts explicitly; unavailable is never perfect. | Pending, n=0. Shared cards and per-capture consent; editor procedure in timing rules. One observer must cover both stop/insertion to claim whole latency; otherwise mark unavailable. Numerical bounds require pre-trial acceptance. |

## Reproduction procedures

**A — source checks**, Windows PowerShell, from the final worktree. Run affected
coverage first, then these required checks; stop on failure. Inherited
`ELECTRON_RUN_AS_NODE` may need removal in this test process for Electron fixtures.
Tests use synthetic data; the hosted-only native clipboard test is not permission
to use a daily clipboard. Check each native exit code; PowerShell does not
automatically stop after a native tool failure.

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Location server
uv sync --extra whisper --group dev --frozen
if ($LASTEXITCODE -ne 0) { throw 'Frozen server dependency check failed' }
uv run --no-sync pytest
if ($LASTEXITCODE -ne 0) { throw 'Server tests failed' }
Set-Location ../app
bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Frozen app dependency check failed' }
bun test
if ($LASTEXITCODE -ne 0) { throw 'App tests failed' }
bun run test:history
if ($LASTEXITCODE -ne 0) { throw 'History check failed' }
bun run build
if ($LASTEXITCODE -ne 0) { throw 'App build failed' }
Set-Location ..
python scripts/version.py check
if ($LASTEXITCODE -ne 0) { throw 'Version check failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Diff check failed' }
```

[CI](../../.github/workflows/ci.yml) supplies Trunk Integration Target, Version
Consistency, App Test And Build, and Server Tests. Record the final head, not an
ancestor's green status. CodeRabbit unresolved actionable findings stay open.

**B — exact existing candidate verification**, after separate authorization. Set
external paths, independently accepted manifest hash, reviewed commit and exact
candidate tag from the ledger. Do not manufacture a tag or manifest to satisfy
this check. Run only in a disposable Windows VM/runner with a fresh synthetic
OS user profile and no daily data mounted. `$isolatedInstallDir` must already
contain the authorized candidate installed through the existing lifecycle route;
this verifier does not install it. Use an external `$qaEvidenceRoot` with an
existing canonical parent, separate from measured install bytes. Redirect all
supported Hugging Face cache variables before the child server starts; a saved
higher-priority cache override must not point at daily data. Environment overrides
alone do not make a daily workstation an isolated release-test host.
From repository root in that disposable environment, use existing scripts:

```powershell
$ErrorActionPreference = 'Stop'
$env:HF_HOME = Join-Path $qaEvidenceRoot 'huggingface'
$env:HF_HUB_CACHE = Join-Path $env:HF_HOME 'hub'
$env:HUGGINGFACE_HUB_CACHE = $env:HF_HUB_CACHE
New-Item -ItemType Directory -Path $env:HF_HUB_CACHE -Force | Out-Null
./scripts/release-artifacts.ps1 -Mode Verify -ArtifactDir $artifactDir -ExpectedTag $candidateTag -ExpectedCommit $candidateCommit -ExpectedManifestSha256 $manifestHash
./scripts/release-verify.ps1 -ExpectedVersion $candidateVersion -InstallerDir $artifactDir -InstallDir $isolatedInstallDir -BaseBranch trunk
```

Use `-AllowUnsigned` only when explicitly authorized by existing signature policy;
it is not a default waiver. Verification does not grant packaging/publication
permission. Run in a dedicated PowerShell process and close it afterward so QA
cache overrides do not leak into normal development. The verifier's tiny/CPU
health probe validates package mechanics; it is not the small-model physical
baseline or permission to change saved settings. Keep raw paths and logs external;
publish only reviewed summaries.

**C — installer lifecycle:** reference
[scripts/installer-lifecycle-ci.ps1](../../scripts/installer-lifecycle-ci.ps1) and
its [existing workflow](../../.github/workflows/installer-lifecycle-ci.yml). It has
hosted-runner and approved-ref protections and pinned historical baseline. It is
not a general local command; do not fabricate GitHub runner variables. B4 branches
currently skip it under existing allowlists. After an authorized candidate, the
release owner uses the applicable existing route or isolated VM lifecycle under
the plan. Keep fresh install, upgrade, uninstall and rollback evidence distinct.
No skipped job is a passing lifecycle result.

**D — soak allocation:** before each run, freeze hardware/settings, warm-up/load,
noise convention and sampling interval. Provisional minimum: 20 Quick trials
and a 30-minute Long run per mic/noise/speaker configuration, with declared script
repetitions, expected manual stops and silence/auto-stop checks. Each capture
requires a new agreement. Sample app/server process RSS and CPU under one stated
convention every second, separating model warm-up from steady-state behavior;
record unsampled peaks as unavailable. Check cancellation/recovery and spool
cleanup using only the QA-owned processes/profile. These duration/allocation
numbers are provisional and need acceptance before release evaluation.

**E — measured comparison:** use external manifest, safe records and exact source/
artifact verification in the timing benchmark guide. Nearest-rank p50/p95 uses
`ceil(p*n/100)`; require at least 20 observed trials per compatible stratum per
side, and declare scored counts independently. Never combine physical, replay,
synthetic, different hardware/configuration, modes, speakers or edge cases.
Freeze paired input allocation, settings, warm-up and load; hash threshold policy
before evaluating. Reject regressions or missing mandatory acceptance evidence.

## Advisory measurements and provisional limits

Historical CPU small native int8_float32 replay: median 3.15 s, p95 4.39 s,
pooled raw WER 12.0%; optional GPU large-v3-turbo native int8_float16: 0.81 s,
1.02 s, 6.8%. Each used 10 speakers/excerpts times two measured runs after warm-up
(n=20/configuration). They measured streamed recordings, not physical capture or
paste, and are advisory comparison points, not current acceptance thresholds.

The timing guide predeclares optimization guardrails: p50/p95 increase at most
max(200 ms, 10% baseline), WER increase at most 1 percentage point, no increased
empty/unexpected failure rates or additional critical entity errors; CPU relative
increase at most 10%, RSS increase at most max(10%, 100 MiB); no partial/auto-stop/
recovery/insertion regression. These are **provisional**, not accepted release
requirements. Missing resources or actual insertion cannot produce an accepted
optimization. No measured CPU optimization is currently applied.

First establish an exact-artifact physical baseline and review hardware/speaker
coverage. The release acceptor then freezes explicit absolute quality, critical
entity, empty/failure, insertion and resource limits plus comparative latency
bounds before evaluating a candidate/optimization. Record approval and policy
hash in the ledger. Until accepted bounds and evidence exist, G8/G10 remain
pending. Advisory diagnostics include stage decomposition, thermals/load,
first-partial quality, extra hardware/accent surveys and model download duration;
poor advisory evidence may motivate investigation but does not silently invent a
release blocker or waive a mandatory one.

## Acceptance status

Task 1 protocol/harness is implemented; physical baseline pending. Task 2 tracing,
replay and regression rules are implemented; current CPU measurement and paired
before/after evidence pending, no safe optimization supported yet. Task 3 this
runbook defines gates; applying accepted numerical bounds to product evidence is
pending. B4 is not complete and this runbook makes no alpha-ready claim.
