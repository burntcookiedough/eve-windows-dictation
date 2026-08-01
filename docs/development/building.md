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
uv run python -m src.main
```

Use `uv sync --extra all --frozen` only when preparing the shipped closure that
includes both engines. Development commands must use the current clone, never a
copied user environment.

## Windows package preparation

The supported installer is `nsis-web`. Before a release-authorized package attempt:

```powershell
Set-Location server
uv sync --extra all --frozen
../scripts/prepare-python-runtime.ps1 -ServerDir .

Set-Location ../app
bun run package:win
```

`prepare-python-runtime.ps1` copies and verifies the standalone `.runtime` CPython
root. Do not substitute a virtual-environment launcher, move caches, or modify the
frozen app identity, NSIS GUID, profiles, install chain, or historical release assets.
The package script uses `--publish never`; package, tag, upload, draft, and public
release actions each require their applicable authorization and release plan.

## Checks

```powershell
Set-Location ..
python scripts/version.py check --tag v0.8.0
git diff --check
```

See [installer dependencies](../installer-dependencies.md), the
[protocol](../protocol.md), and the [Gate 6 release plan](../architecture/eve-gate-6-release-plan.md)
for release-specific requirements.
