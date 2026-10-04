# Eve lean runtime plan

Status: design and measurement baseline. This is a proposal for a future release candidate, not a released installer or an approved GPU binary set.

## Goal and accounting

Minimize the download and installed size of the default Windows app while retaining CPU dictation, history, hotkeys, and an optional path to NVIDIA acceleration. Report three different numbers for every candidate: the `nsis-web` payload archive, the installed app directory, and a fresh test model cache or published model weight size. Do not combine them into one “app size.” Use `scripts/measure-package-footprint.ps1` for prepared source trees and generated installer files; it does not measure the installed app or model cache. Measure an isolated test install separately, without reading existing user caches. At the start of this audit the checkout had no prepared `.venv`, `.runtime`, or installer archive, so the 185 MB / 450 MB targets in the supplied HTML remain unverified estimates.

The current `release` extra installs CUDA-enabled PyTorch (`server/pyproject.toml` and `server/uv.lock`). Electron and Python add `torch/lib` to the DLL search path; Python also imports PyTorch for device information and cleanup. Faster-Whisper inference uses CTranslate2. Model weights are downloaded separately. The HTML plan correctly points at the large CUDA closure, but its claim that PyTorch can simply be removed while preserving GPU behavior is false for the current code. Its suggested `Settings.svelte` path does not exist, and its package-filter example conflicts with removing PyTorch from the base closure.

### Measured Windows Python closure (2026-09-25)

These are raw directory bytes from the locked CPython 3.11 build on this machine, before Electron Builder filters or archive compression. The same `scripts/measure-package-footprint.ps1` command measured both states.

| Prepared closure | `site-packages` | Standalone Python | Evidence |
| --- | ---: | ---: | --- |
| Current `--extra release` | 4,941,557,529 bytes | 75,592,946 bytes | PyTorch directory 4,644,232,862 bytes; `torch/lib` 4,570,126,492 bytes. |
| CPU `--extra whisper` | 285,496,116 bytes | 75,592,946 bytes | Faster-Whisper and CTranslate2 imported; CPU compute types were reported. |

The observed Python package difference is **4,656,061,413 bytes** (94.2%). This is not the installer saving: Electron Builder already excludes some large files, including static `.lib` files, and archive compression changes the number again. Inside `torch/lib`, DLLs total 3,763,211,944 bytes and static `.lib` files total 806,914,548 bytes. The largest DLL is `torch_cuda.dll` at 957,267,456 bytes; we must prove whether the GPU pack can omit it. No new installer archive or real GPU transcription was measured in this pass.

## Chosen shape

1. **CPU base.** Make the release install only the supported Faster-Whisper/CTranslate2 CPU closure. Keep the standalone Python runtime, Electron identity, `nsis-web`, settings, and protocol unchanged. A clean release sync must prove PyTorch and CUDA DLLs are absent from the base payload; a source-level filter alone is insufficient. CPU transcription must work with no NVIDIA driver and no external pack.
2. **Versioned GPU pack.** Build a separate, architecture-specific, pinned set of CUDA and cuDNN runtime DLLs from reviewed redistributable inputs. Do not ship the PyTorch Python package merely to supply DLLs. Record each DLL's source version, license review, size, and SHA-256 in a manifest tied to the CTranslate2 version. Determine the minimal DLL set by inspecting native dependencies **and** running real GPU inference; the “four DLLs” claim is unproven.
3. **Single runtime seam.** Electron owns download, hash verification, staging, and atomic activation in a versioned, machine-local Eve runtime directory. Python receives only the validated active DLL directory and registers it before importing CTranslate2. The server reports CPU, GPU ready, pack missing, and pack invalid through existing diagnostics. Separate requested and effective device values: `auto` uses CPU until a valid pack and usable GPU are present; a saved explicit `cuda` preference must remain intact and show a clear CPU fallback or unavailable state. The current `get_settings()` replaces all loaded settings with defaults when runtime compatibility rejects `cuda`; a real-code probe confirmed that this loses other saved values for the running session. That must be fixed before a CPU-first build.
4. **Small Settings surface.** Offer an optional GPU download and its byte size in the existing `SettingsView.svelte` flow. Show progress, retry, and a restart requirement if needed. No install-time download and no background download without user action. CPU dictation remains available if the download or validation fails.
5. **Release coupling.** Extend the exact-asset manifest, license notices, release verifier, and protected release asset allowlist for the pack. An app version accepts only compatible, hash-pinned packs. Never run a downloaded installer or script, or load native DLLs, before validating the exact pinned archive and member hashes. Do not trust a user-selected DLL path or delete model caches or old profiles as part of this change.

The public interface should be small: `getGpuPackState()`, `installGpuPack()`, and `getValidatedGpuRuntimePath()`. Download mechanics and validation live behind that interface. The server consumes a validated path and exposes effective device capability; it does not know where the pack was downloaded from.

## Implementation and proof gates

| Gate | Work | Required proof |
| --- | --- | --- |
| 0. Baseline | Prepare the current locked Windows release closure and measure package groups, installed size, and compressed archive. | Save exact tool versions, tree totals, archive bytes, and top package/DLL sizes. No private profiles or cache contents. |
| 1. Base subtraction | Remove unused direct dependencies; split the CPU release and GPU build closures; replace PyTorch-only CPU/GPU probing with CTranslate2 and a bounded NVIDIA device query. | CPU Quick and Long dictation, settings validation, diagnostics, server health, installer smoke, and release verifier on a clean Windows install. Assert no torch package or CUDA runtime in the base. |
| 2. GPU pack | Pin inputs and manifests; produce the minimal DLL archive; implement verified, atomic opt-in installation and runtime path activation. | Clean NVIDIA machine: CUDA startup and real transcription; corrupt/truncated/wrong-version archive rejection; CPU fallback; update/restart/rollback; no system CUDA dependency. |
| 3. Release | Compare baseline and candidate bytes and latency, then update release asset controls and notices. | Exact-head `nsis-web` lifecycle, required tests, manifest/hash validation, and review of redistribution terms before publication. |

The default installer size is a measured acceptance criterion, not a guessed target. A meaningful win should remove most of the current CUDA/PyTorch bytes from the default payload. Publish the measured CPU and GPU sizes side by side, including the separate model download. If a GPU pack cannot pass real GPU inference or its distribution terms cannot be cleared, ship no GPU pack and leave the current release behavior unchanged until the product choice is revisited.

## Immediate verified subtraction

`soundfile` was a direct core dependency with no imports in the app or server source. It has been removed from `server/pyproject.toml` and the offline-resolved lockfile. This is a small reduction and does not stand in for the CPU/GPU split.

Electron Builder now excludes `dist/**/*.map` from the shipped app. The current main/preload build emits 1,429,714 bytes of source maps, useful for development but unnecessary in the installer. The build still generates them locally.
