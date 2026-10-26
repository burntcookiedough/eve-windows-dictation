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
`release-verify.ps1` also rejects unsupported archive methods and fails if 7-Zip
cannot list the payload. It resolves the pinned builder tool or accepts an
explicit `-SevenZipPath`. Source tests do not replace exact-source installation
and lifecycle evidence, which still require separate authorization.

`installer-smoke.ps1` refuses to run over an active target installation; close
that session explicitly. It never stops existing Eve/Python processes by name.
Forced cleanup retains handles to this run's launcher and validated descendants,
checks exact installed executable paths and parent/creation identity, and waits
for each owned process to exit. Parents stop before descendant enumeration so
they cannot spawn more children during that scan. Windows retains process IDs
while their process objects have open handles ([Microsoft process lifetime
contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information)).
An inaccessible or changed identity fails cleanup instead of authorizing an
unsafe stop or reporting success. A PID-file claim alone never authorizes cleanup.
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
