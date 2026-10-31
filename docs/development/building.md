# Building Eve on Windows

Eve targets Windows. Run dependency, test, build, and packaging commands in Windows
PowerShell only; WSL must not create `.venv` or `node_modules`.

## Prerequisites

Install Bun, uv, a managed Python 3.11 runtime, and PowerShell 7. An NVIDIA driver is
optional for GPU transcription. The repository retains Murmur package, environment,
and runtime names for compatibility.

## Development

From the repository root in PowerShell:

```powershell
Set-Location app
bun install --frozen-lockfile
bun run build

Set-Location ../server
uv sync --extra whisper --group dev --frozen
uv run pytest
uv run --no-sync python (Resolve-Path src/main.py).Path
```

### Local data and reset scope

Quit Eve and stop any separately started speech server through its owner before
resetting data. Back up the intended profile and decide which data may be lost.
Reinstalling the app and resetting its settings are separate operations.

The existing `bun run clear-data` helper, run from `app/`, targets the default
Windows profile `%APPDATA%\Eve`. It deletes `settings.json`, `history.db`,
`history.db-wal`, and `history.db-shm`: this discards transcription History and
its derived Insights as well as app preferences. It does not reset
`server-settings.json`, `internal.json`, browser/session storage, model caches,
or optional GPU packs. QA command-line profile flags do not redirect this helper;
do not use it to reset an isolated QA profile.

The managed server's preferences live in `<userData>/server-settings.json`,
passed by Electron through the frozen `MURMUR_SETTINGS_FILE` override. A standalone
server uses that override when set, otherwise `<repo>/server/settings.json`.
To reset only persisted server preferences, stop that instance and back up that
specific file before intentionally replacing its JSON object with `{}`. Explicit
environment and `.env` values still take precedence. This does not reset app
preferences or History and does not authorize deleting other profiles or caches.

Do not delete `server.pid` as a settings reset: removing a PID record does not
stop its process and can hide a running owner from later discovery. Let the
owning app or server perform its normal shutdown cleanup.

### Standalone PID ownership

Without a nonempty `MURMUR_PID_FILE`, the Python server uses these standalone
defaults. The platform roots are retained; `Eve/standalone` separates unmanaged
PID ownership from Electron's profile even where the roots coincide.

| Platform | Standalone PID path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Eve\standalone\server.pid` |
| Windows without `LOCALAPPDATA` (or with an empty value) | `~/AppData/Local/Eve/standalone/server.pid` |
| macOS | `~/Library/Application Support/Eve/standalone/server.pid` |
| Linux | `~/.local/share/Eve/standalone/server.pid` |

A nonempty `MURMUR_PID_FILE` takes precedence unchanged: relative paths remain
relative to the process working directory, `~` is not expanded, and whitespace
is not trimmed. Empty or unset values select the fallback. Write, read, normal
exit, failure cleanup, and the registered exit hook use the same resolver. The
JSON fields remain `pid`, `port`, and `startedAt` (Unix milliseconds). No fallback
operation searches, adopts, migrates, or removes legacy Murmur files. Concurrent
standalone instances need distinct explicit PID paths.

The installed `uv run --no-sync murmur` CLI also calls `main:main` and uses this
resolver. `bun run dev` starts Vite and Electron, not Python. Electron development
detection still reads `<userData>/server.pid`, and packaged launches supply that
exact path through `MURMUR_PID_FILE`; neither uses the standalone default.
Release verification supplies its own isolated `release-verify-server.pid`.

To make a manually started server discoverable by Electron development mode on
Windows, run from `server/` in PowerShell:

```powershell
$env:MURMUR_PID_FILE = Join-Path $env:APPDATA 'Eve\server.pid'
uv run --no-sync python (Resolve-Path src/main.py).Path
```

This matches the normal Eve `userData` path. If Electron's appData root is
explicitly isolated for QA, supply that instance's exact `<userData>/server.pid`
instead. Use the absolute Python script path above: the process ownership check
requires a Python command line naming `server/src/main.py`; the CLI and
`python -m src.main` forms do not satisfy that check. The PID override alone does
not bypass process ownership or health validation. Remove the override from the
shell with `Remove-Item Env:MURMUR_PID_FILE` after the manual server exits if
subsequent launches should use the standalone default.

Use `uv sync --python 3.11 --no-dev --extra release --frozen` when preparing the
shipped Faster-Whisper closure. Pinning the sync interpreter keeps compiled
packages compatible with the relocatable runtime, and `--no-dev` keeps the
default development group out of the shipped environment. Development commands
must use the current clone, never a copied user environment. Additional model
families require a separately reviewed adapter and release dependency closure.

## Windows package preparation

The supported installer is `nsis-web`. Before a release-authorized package attempt:

```powershell
Set-Location server
uv sync --python 3.11 --no-dev --extra release --frozen
../scripts/prepare-python-runtime.ps1 -ServerDir .

Set-Location ../app
bun run package:win
```

`prepare-python-runtime.ps1` checks that the synced `.venv` and managed runtime
use the same Python ABI before copying and verifying the standalone `.runtime`
CPython root. Do not substitute a virtual-environment launcher, move caches, or
modify the frozen app identity, NSIS GUID, profiles, install chain, or historical
release assets.
The package script uses `--publish never`; package, tag, upload, draft, and public
release actions each require their applicable authorization and release plan.

The Windows `beforePack` hook selects BCJ compression so the NSIS extractor can
decode every intended file, including ARM64 Python helpers. Do not remove files
to work around an unsupported compression filter.

For an authorized candidate, retain a byte manifest before removing `win-unpacked`:

```powershell
Set-Location .. # From app back to the repository root.
. ./scripts/installer-manifest.ps1
New-InstalledPayloadManifest -SourceDir ./app/release/win-unpacked -OutputFile ./candidate-payload-manifest.json
```

Keep this QA manifest outside the payload and the frozen release asset set. Pass
its path as `-ManifestPath` to `installer-smoke.ps1` and `release-verify.ps1` to
compare every expected installed file's length and SHA256. Without it, those
standalone scripts explicitly report byte verification as unverified. The hosted
lifecycle gate requires the manifest and checks the candidate after upgrade;
historical baseline files are not compared to the candidate manifest.
After rollback and baseline removal, the hosted gate separately installs the
candidate into a fresh runner-owned installation and QA profile, verifies its
bytes and explicit tiny/CPU test runtime, and uninstalls it. The earlier profile
and shared QA cache remain intact; this is not default-model or physical-mic proof.
`release-verify.ps1` also rejects unsupported archive methods and fails if 7-Zip
cannot list the payload. It resolves the pinned builder tool or accepts an
explicit `-SevenZipPath`. Source tests do not replace exact-source installation
and lifecycle evidence, which still require separate authorization.

### Hosted lifecycle candidate retention and upload controls

Manual `workflow_dispatch` runs of the installer lifecycle gate require an exact
`expected_commit` 40-character lowercase SHA matching both the workflow event and
`git rev-parse HEAD` before runner dependencies or packaging proceed. Candidate
artifact retention is an explicit manual boolean opt-in (`retain_candidate: true`,
default `false`); automated pull request runs and default manual dispatches do not
upload candidate assets. The isolated runner stages a verified set for lifecycle
binding regardless of upload opt-in; it is otherwise discarded with the runner.

When opted in, the workflow retains seven self-contained candidate assets
(`Eve.Web.Setup.<version>.exe`, `murmur-<version>-x64.nsis.7z`, `latest.yml`,
`THIRD_PARTY_NOTICES.txt`, `SHA256SUMS.txt`, `SHA512SUMS.txt`, and
`eve-v<version>-artifact-manifest.json`) alongside separate QA evidence
(`candidate-payload-manifest.json`, `candidate-provenance.json`, and
`candidate-phase-status.json`) with a 7-day retention limit and an explicit unsigned
QA label (`eve-v<version>-unsigned-candidate-qa-<run-id>`).

Signed-in users with repository read access can download these Actions artifacts;
on this public repository they must not be treated as private storage. Upload
requires its own explicit run authorization. Upload is gated on successful staging
and a final integrity check. Failed lifecycle runs may retain diagnostic artifacts,
clearly marked failed; partial or unverified staging is never uploaded. Individual
phase results and owned-process cleanup must succeed before reporting overall pass.
Retained QA artifacts are generated solely for automated diagnostic proof. Building
or verifying an unsigned candidate with `win.signExecutable = false` via the electron-builder
API and validating via `release-artifacts.ps1 -AllowUnsigned` confirms packaging
integrity only; an Authenticode status of `NotSigned` is not a release waiver and
does not authorize signing, tagging, uploading release assets, or public release.
Actual lifecycle phase outcomes are recorded directly in the phase evidence; synthetic
sentinel validation does not establish functional History persistence or physical
microphone acceptance.

### Hosted retained-candidate History acceptance

Manual `workflow_dispatch` runs of `.github/workflows/retained-history-ci.yml`
exercise packaged functional History acceptance on a disposable GitHub-hosted
Windows runner. Rather than rebuilding a candidate, this lane consumes the
cryptographically verified retained candidate artifact (`runId: 40751101623`)
and tests packaged baseline schema initialization, fixed fictional row seeding,
packaged renderer History read/filter/render, designated IPC deletion, exact
persistence across relaunch, and baseline rollback via loopback CDP. It uploads
one explicit aggregate JSON evidence file for 7 days with no raw transcription,
profile, audio, or log uploads. The harness commit is guarded separately from
the pinned candidate source; this lane never rebuilds or modifies that candidate.
Execution requires its own approved run. Seeded-record persistence does not prove
new dictation creation, reboot behavior, microphone capture, or editor insertion.

`installer-smoke.ps1` refuses to run over an active target installation; close
that session explicitly. It never stops existing Eve/Python processes by name.
Forced cleanup retains handles to this run's launcher and validated descendants,
checks exact installed executable paths and parent/creation identity, and waits
for each owned process to exit. Existing child handles are pinned before stopping
a parent; a second scan
captures children born during the first scan after further spawning has stopped.
Windows retains process IDs
while their process objects have open handles ([Microsoft process lifetime
contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information)).
An inaccessible or changed identity fails cleanup instead of authorizing an
unsafe stop or reporting success. A PID-file claim alone never authorizes cleanup.
Preflight also refuses unverifiable process paths; use an isolated QA host with
visibility into its target processes. Clean exits after capture retain their
bound creation identity, and an immediate launcher exit uses the original
creation handle and requested image instead of requiring a live module query.
Windows console hosts are waited on after their owned clients stop; the smoke
script never forcibly terminates those OS executables.
The synthetic process tests execute only extracted functions and the actual
cleanup block; they do not run an installer or establish packaged lifecycle proof.

## Checks

History saves persist the transcription before committing Insights aggregates and
the processed-entry ledger in one SQLite transaction. If Insights fails, the
dictation remains in History and startup catch-up retries its derived writes.
The native `test:history` check injects failures at each Insights write stage and
verifies retained text, aggregate rollback, restart, and idempotent catch-up.

On quit, Eve gives the renderer ten seconds to acknowledge deferred History
deletes. Rejection or timeout keeps the app and deletion owner open, brings the
window forward, and allows another quit attempt. A late acknowledgement from an
expired attempt cannot close the app. This deadline does not cancel an in-flight
delete or silently discard it. The shutdown tests retain the native delayed
acknowledgement check; the pagination fixture exercises empty-filter recovery
using native intersection events in rendered Electron, including an always-visible
list end and delayed responses that finish after the first intersection event.

Run from the repository root:

```powershell
python scripts/version.py check
git diff --check
```

See [installer dependencies](../installer-dependencies.md), the
[protocol](../protocol.md), and the [lean-runtime release plan](../architecture/eve-lean-runtime-release-plan.md)
for the retained release controls; each new release needs its own authorization. Historical Gate 6 evidence remains
in [its release plan](../architecture/eve-gate-6-release-plan.md).
