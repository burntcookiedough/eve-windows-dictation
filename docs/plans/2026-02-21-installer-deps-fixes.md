---
# Installer Dependencies Fixes (nsis-web)

## Overview
Switch the Windows installer to nsis-web to bypass the NSIS 2GB limit, ensure release builds include both engines, add runtime dependency diagnostics and model-download UX, and update installer-dependencies documentation to reflect the new behavior and requirements.

## Context
- Files involved: `docs/installer-dependencies.md`, `.github/workflows/release.yml`, `app/package.json`, `BUILDING.md`, `README.md`, `justfile`, `app/src/shared/types.ts`, `app/src/main/services/server-manager.ts`, `app/src/main/ipc/handlers.ts`, `app/src/renderer/app/views/ServerView.svelte`, `server/src/app.py`, `server/src/transcription/engines/whisper.py`, `server/src/transcription/vram.py`
- Related patterns: electron-builder config in `app/package.json`, server health/settings endpoints in `server/src/app.py`, server log streaming to UI via `ServerManager` and `ServerView`
- Dependencies: optional `nvidia-smi` availability on Windows for driver checks; use existing Python/Node standard libs to avoid new runtime deps

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Use existing build/test scripts and avoid new runtime dependencies where possible
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Switch Packaging to nsis-web and Fix Release Workflow

**Files:**
- Modify: `app/package.json`
- Modify: `.github/workflows/release.yml`
- Modify: `justfile`

- [x] Update electron-builder Windows target to `nsis-web`, and add a `publish` config for GitHub so the web installer can locate payload artifacts
- [x] Update release workflow to install server deps with `uv sync --extra all`
- [x] Update release artifact upload patterns to include nsis-web payload files (for example `.7z` or `.zip` plus `.yml` and `.blockmap`)
- [x] Keep `package:win` script stable while ensuring it produces nsis-web outputs
- [x] Add/update tests for build config correctness (for example a pytest that asserts nsis-web target and `uv sync --extra all` in the release workflow)
- [x] Run test suite relevant to config checks and ensure it passes before Task 2

### Task 2: Add Runtime Dependency Diagnostics (VC++ Redist, CUDA DLLs, Driver)

**Files:**
- Modify: `server/src/app.py`
- Modify: `server/src/transcription/engines/whisper.py`
- Create: `server/src/diagnostics.py`
- Modify: `app/src/shared/types.ts`
- Modify: `app/src/main/services/server-manager.ts`
- Modify: `app/src/renderer/app/views/ServerView.svelte`

- [ ] Implement a diagnostics module that checks CUDA DLL availability (CTranslate2), CUDA capability, and optionally driver version via `nvidia-smi`
- [ ] Add a lightweight VC++ redist check on Windows and surface the result as a warning with an install link
- [ ] Expose diagnostics data via `/health` or a new `/diagnostics` endpoint and wire it into app state
- [ ] Surface warnings in the Server view with actionable guidance (driver too old, missing redist, CUDA DLLs missing)
- [ ] Add/update tests for diagnostics helpers and API payloads
- [ ] Run test suite and ensure it passes before Task 3

### Task 3: Improve First-Run Model Download UX

**Files:**
- Modify: `server/src/transcription/engines/whisper.py`
- Modify: `server/src/app.py`
- Modify: `app/src/shared/types.ts`
- Modify: `app/src/renderer/app/views/ServerView.svelte`

- [ ] Add a model preflight check that detects whether required models are present in the HF cache before loading
- [ ] Expose model download state via server API and emit logs or status updates when a download is occurring
- [ ] Add UI messaging for first-run model download with size estimates, progress or “downloading” state, and retry guidance
- [ ] Add/update tests for model status detection and UI state handling
- [ ] Run test suite and ensure it passes before Task 4

### Task 4: Verify Acceptance Criteria

**Files:**
- Modify: `scripts/installer-smoke.ps1` (new or existing)

- [ ] Add/update a smoke-test script for Windows install and first-run model download
- [ ] Manual test on a clean Windows machine using the nsis-web installer: install, launch, server starts, GPU detection, model download completes
- [ ] Run full automated test suite (pytest, any node tests added)
- [ ] Run linter if configured
- [ ] Verify test coverage meets 80%+

### Task 5: Update Documentation

**Files:**
- Modify: `docs/installer-dependencies.md`
- Modify: `BUILDING.md`
- Modify: `README.md`

- [ ] Update installer-dependencies doc to reflect nsis-web, resolved blockers, and updated dependency guidance
- [ ] Update BUILDING and README to match the new packaging flow and system requirements
- [ ] Add/update doc consistency checks (for example a pytest that validates required sections or references)
- [ ] Run test suite and ensure it passes
- [ ] Move this plan to `docs/plans/completed/`
---
