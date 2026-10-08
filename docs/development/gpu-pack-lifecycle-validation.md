# GPU pack lifecycle validation on Windows

This runbook covers B6 download, storage, and recovery evidence. Tiny artificial
DLLs prove component handling; they cannot prove CUDA loading or GPU inference.
The [GPU provenance](../architecture/eve-gpu-pack-provenance.md) records historical
hardware evidence, and the [lean runtime release plan](../architecture/eve-lean-runtime-release-plan.md)
continues to govern packaging and publication. Historical evidence does not apply
automatically to a new candidate.

## Automated source checks

Use a fresh worktree and Windows PowerShell. Keep fixture profiles, logs, and
screenshots outside the public diff. Do not use personal recordings, profiles,
model caches, or transcripts. From the repository root:

```powershell
git rev-parse HEAD
Set-Location app
bun install --frozen-lockfile
bun test tests/gpu-pack-manager.test.ts
bun test
bun run test:history
bun run build
Set-Location ../server
uv sync --extra whisper --group dev --frozen
uv run --no-sync pytest
Set-Location ..
python scripts/version.py check
git diff --check
```

Record the exact tested head, tool versions, exit codes, test totals, and any
fixture skips. New lifecycle and rendered Settings tests are included in the
full app suite. A passing build alone does not establish the Settings flow.

## Exact-candidate packaged evidence

Packaging requires the applicable release plan and separate explicit authority.
Do not tag, upload, publish, sign, alter released assets, or change versions/locks
as part of these source checks. Once a candidate is authorized, record its exact
commit, candidate tag, installer/payload hashes, Windows version, and hardware.
Build it using the documented Windows release-runtime preparation and
`nsis-web` procedure. Run the following only in isolated disposable QA profiles
and manager storage, with a separate clean model cache where needed.

| Exercise | Procedure and required evidence |
| --- | --- |
| Interruption | Start an explicit download, interrupt the network after measurable progress, and record the safe error and retained manager-owned partial. Restore the network and prove the next request resumes at the verified offset or safely restarts if Range is ignored. |
| Application restart | Interrupt again, close the app, reopen the same isolated QA instance, and prove recovery without publishing unverified bytes or loading a partial directory. |
| Repeat installation and Repair | Complete installation, repeat the install request, then run Repair. Confirm the exact pinned DLL sizes/hashes, a valid manifest, and no duplicate network transfer for a healthy installed pack. Corrupt only an isolated owned test copy and prove Repair restores it. |
| Insufficient disk | Use a disposable constrained test volume. Prove failure before large writes and simulated exhaustion during writing. Confirm any current validated pack is byte-for-byte intact and retry works after space is restored. |
| Runtime ownership and Remove | While a server may have loaded the pack, request Remove and prove safe deferral. Stop the managed server and verify the process is dead; confirm Remove and prove only identified owned component data disappears. For an external server, stop it using its owner before retrying. |
| Upgrade | Install an authorized newer candidate against the isolated QA storage. Confirm current-plus-prior retention, no in-place mutation, and compatible exact runtime selection. Record saved model/device preferences before and after. |
| Rollback | Reinstall the authorized prior candidate. Confirm it revalidates its own retained pack, selects only its compatible identity, and keeps CPU usable if that pack is absent or broken. |
| Uninstall and retention | Uninstall through the supported installer. Record which isolated component files remain under the unchanged installer policy. Reinstall, then explicitly Remove and verify its narrower deletion policy. Check sentinel files in unknown directories remain unchanged. |
| CPU fallback | Start without a pack, and with an isolated broken pack. Confirm CPU operation remains usable, requested device/model preferences remain saved, and Settings explains effective CPU fallback. Prove CPU transcription with a synthetic nonpersonal fixture if a model/runtime is available. |
| GPU inference | On suitable NVIDIA hardware with system CUDA Toolkit paths excluded, confirm Windows module provenance and actual inference through the managed pack. Device discovery and fake DLL tests are insufficient. |

Capture screenshots of confirmation, deferred removal, retryable storage/download
errors, resumed progress, and ready/missing state. Inspect Settings at normal and
high zoom; verify focus, keyboard cancellation/confirmation, readable wrapping,
and controls when the server is unavailable. Redact filesystem paths and download
URLs from any renderer-facing diagnostic evidence.

## Acceptance and integration

Report source implementation/automated validation separately from packaged batch
acceptance. Mark each unavailable packaged or hardware exercise as pending with
its exact next step. Do not substitute a previous candidate's results or a
worker's report for exact-head proof.

B4 performance instrumentation, microphone protocol, and recorded baseline are
separate unfinished validation work. Preserve those branches. After both batches
land, rerun server restart/stop, CPU/GPU runtime selection, and B4 timing/replay
checks on the integrated candidate; B6 download/storage fixtures require no
microphone recordings.
