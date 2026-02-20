---
description: WSL/Windows environment safety rules for all commands
globs:
alwaysApply: true
---

# WSL Environment Safety — MANDATORY

This workspace is opened from WSL but ALL runtime targets are Windows.

## NEVER run these directly from WSL

- `uv run`, `uv sync`, `uv pip`, `uv add`, `uv remove`
- `pytest`, `python`, `pip`, `pip install`
- `bun run`, `bun install`, `bun add`
- `npm install`, `npm run`, `npx`
- Any command that reads/writes `.venv` or `node_modules`

## ALWAYS use PowerShell for runtime commands

```bash
/mnt/c/Program\ Files/PowerShell/7/pwsh.exe -NoProfile -Command "<command>"
```

## Why

Running package managers from WSL creates Linux environments that destroy the Windows `.venv`/`node_modules`, breaking the running server and Electron app. The damage is silent and only manifests as missing modules, wrong binaries, or TLS errors at runtime.

## Safe from WSL

Reading/writing source files, git, grep/rg, code search — anything that doesn't touch `.venv`, `node_modules`, or produce platform-specific artifacts.
