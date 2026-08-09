# Murmur Installer: End-User Dependency Research

> Research date: February 2026
> Scope: What does a user need on their system when they download the Murmur installer from GitHub Releases?

---

## Executive Summary

The Murmur installer bundles a self-contained Python environment (no system Python needed) and the Electron app. GPU acceleration depends on CUDA runtime libraries that are bundled via PyTorch when both engines are installed, and **AI models are not included in the installer** — they download on first run. The release pipeline now installs all engines and ships a nsis-web installer with payload artifacts; remaining risk areas are GPU drivers, Visual C++ Redistributable availability, and first-run model download bandwidth.

### Key Findings

| Finding | Severity | Status |
|---------|----------|--------|
| Release workflow installs transcription engines | **Critical** | Resolved |
| NSIS 2GB installer size limit vs. 5+ GB bundled venv | **Critical** | Resolved via nsis-web |
| CUDA DLL gap when using Whisper-only (no PyTorch) | **High** | Mitigated (default build + diagnostics) |
| NeMo Toolkit not officially supported on Windows pip | **Medium** | Known risk |
| Visual C++ Redistributable check/bundling | **Low** | Resolved (runtime warning + link) |
| Models download on first run (~2-4 GB) | **Info** | Documented + UI messaging |

---

## 1. What the Installer Bundles

The nsis-web installer produced by `bun run package:win` includes a small web installer plus payload archives in `app/release/`. During install, the stub downloads payloads (requires internet). The payload contents are:

| Component | Source | Approx. Size |
|-----------|--------|--------------|
| Electron runtime (Chromium + Node.js) | `app/dist/` | ~150-200 MB |
| App resources (icons, etc.) | `app/resources/` | < 1 MB |
| Native Node modules (better-sqlite3, uiohook-napi) | `app/node_modules/` (rebuilt for Electron) | ~10 MB |
| Python interpreter | `server/.runtime/python.exe` (uv-managed python-build-standalone runtime) | ~100 MB |
| Python packages | `server/.venv/Lib/site-packages/` | **Varies enormously by extras** |
| Server source code | `server/src/` | ~100 KB |

### What's excluded from the bundle

Per the `extraResources` config in `app/package.json`:
- `__pycache__/` directories
- `.pyc` files
- pip, wheel, setuptools packages
- dependency test suites, static `.lib` linker archives, and PyTorch headers
- standalone-Python development/UI assets (`include`, `libs`, `idlelib`, `tkinter`, Tcl)

These exclusions remove build-time material only. Release validation imports both
engines and runs a WebSocket transcription smoke against the packaged runtime
layout before publication.

### What's NOT in the installer at all

- AI models (downloaded on first run)
- CUDA toolkit / cuDNN (system dependency; not required for default build)
- Visual C++ Redistributable (system dependency; app warns and links installer if missing)
- GPU drivers (system dependency)

---

## 2. End-User System Requirements

### 2.1 Always Required

| Requirement | Details |
|-------------|---------|
| **Windows 10/11** | x86_64 only. ARM64 not supported. |
| **Disk space** | ~5-8 GB for app payloads + ~2-4 GB for models on first run |
| **RAM** | 4 GB minimum, 8 GB+ recommended |
| **Internet** | Required for nsis-web install (payload download) and first-run model download |
| **Visual C++ Redistributable** | Required by Electron native modules and Python C extensions. Usually pre-installed on Windows 10/11. If missing, the app warns and links to [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe). |

### 2.2 For GPU Acceleration (Recommended)

| Requirement | Details |
|-------------|---------|
| **NVIDIA GPU** | Any CUDA-capable GPU (GTX 900 series or newer) |
| **GPU Driver** | >= 525.x (for CUDA 12.4 compatibility). Current recommended: R535 LTS or R570+. The app warns if the driver is too old or `nvidia-smi` is unavailable. |
| **VRAM** | Whisper: ~1.5 GB (int8) to ~2.5 GB (fp16). Nemotron: ~5 GB base + growth, 8 GB+ recommended |

### 2.3 CPU-Only Mode

Works without any GPU. Set device to `cpu` in Settings. Transcription will be significantly slower but functional.

---

## 3. Python Environment: Self-Contained

**Verdict: No system Python required.**

The release copies uv's managed [python-build-standalone](https://github.com/astral-sh/python-build-standalone) distribution into `.runtime` and keeps third-party packages in `.venv/Lib/site-packages`. This avoids copying a virtual-environment launcher that still points to the build machine's base Python.

The packaged app spawns the server via:
```text
PYTHONPATH={resources}/server/.venv/Lib/site-packages
{resources}/server/.runtime/python.exe {resources}/server/src/main.py
```

The release workflow verifies imports and starts `/health` with this exact split-runtime layout before packaging.

---

## 4. CUDA Runtime Libraries and Diagnostics

This is the most complex dependency story and the most likely source of end-user GPU failures. The default release build installs both engines, so PyTorch provides CUDA DLLs, and the app surfaces diagnostics if anything is missing.

### 4.1 How CUDA DLLs Are (or Aren't) Provided

| Component | Bundles CUDA DLLs? | Which DLLs? |
|-----------|-------------------|-------------|
| **PyTorch Windows cu124 wheel** | **Yes** | cublas64_12.dll, cudnn*.dll, cuda runtime — all in `torch/lib/` (~2.5 GB wheel) |
| **CTranslate2 Windows wheel** | **No** | Only the CTranslate2 native library itself (~18 MB) |
| **nvidia-cublas-cu12 pip package** | Windows wheel exists but NOT a dependency of torch on Windows | cublas DLLs |
| **nvidia-cudnn-cu12 pip package** | Windows wheel exists but NOT a dependency of torch on Windows | cuDNN DLLs |

### 4.2 DLL Resolution Chain on Windows

When the server starts:

1. The Electron server launcher prepends the packaged `.venv/Lib/site-packages/torch/lib/` directory to the child `PATH`.
2. `runtime_paths.py` registers that same directory with `os.add_dll_directory()` before settings and optional engine imports load native code.
3. When the engine manager constructs Nemotron, `nemotron.py` imports PyTorch/NeMo; Whisper imports PyTorch before CTranslate2. Both native paths therefore resolve against the same packaged directory.
4. Nemotron runs a real CUDA/cuDNN convolution before a candidate engine is activated; DLL entry-point or device initialization failures become a recoverable preparation error.

**The boundary:** If only the Whisper extra is installed (no Nemotron/PyTorch), CTranslate2 has no bundled CUDA DLL set available, so GPU mode remains unavailable; CPU mode is unaffected.

### 4.3 Runtime Diagnostics

On startup, the server now reports diagnostics that the app surfaces in the Server view:
- CUDA DLL availability for CTranslate2
- CUDA capability (whether the runtime can initialize)
- NVIDIA driver version via `nvidia-smi` when available
- Visual C++ Redistributable presence on Windows

These warnings are actionable and include guidance or links where possible.

### 4.4 Scenarios Matrix

| Build Config | PyTorch? | cuBLAS/cuDNN available? | Whisper GPU? | Nemotron GPU? |
|-------------|----------|------------------------|-------------|--------------|
| `uv sync --extra all` | Yes (cu124) | Yes, via packaged torch/lib/ | Yes (if driver/runtime preflight passes) | Yes (if CUDA/cuDNN preflight passes) |
| `uv sync --extra nemotron` | Yes (cu124) | Yes, via packaged torch/lib/ | N/A (not installed) | Yes (if CUDA/cuDNN preflight passes) |
| `uv sync --extra whisper` | **No** | **No** | **No — GPU broken** | N/A (not installed) |
| `uv sync` (bare) | **No** | **No** | N/A (not installed) | N/A (not installed) |

### 4.5 Recommendation

Build with `--extra all` to ensure PyTorch's locked cu124 wheel and its bundled CUDA DLLs are available for both engines. Eve makes the packaged `torch/lib` directory first in the Windows search order and validates the Nemotron CUDA/cuDNN operation before activation.

For a whisper-only build, you would need to either:
- Add `torch` as a dependency of the whisper extra (heavy, ~2.5 GB)
- Install `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` pip packages in the venv
- Require the end-user to install CUDA Toolkit 12.x separately

---

## 5. Build Pipeline Status (Resolved Blockers)

### 5.1 Release Workflow Installs Engines (Resolved)

The release workflow now runs `uv sync --extra all`, so both Whisper and Nemotron extras are included in the packaged venv. This also ensures PyTorch's CUDA DLLs are present for GPU acceleration in the default build.

### 5.2 NSIS 2GB Installer Size Limit (Resolved via nsis-web)

The build now targets `nsis-web`, producing a small web installer plus payload archives (for example `.7z`, `.yml`, `.blockmap`) in `app/release/`. During install, the stub downloads payloads from GitHub Releases using electron-builder publish metadata, avoiding the 2GB NSIS limit.

### 5.3 NeMo Toolkit Windows Compatibility (Known Risk)

NeMo Toolkit is **not officially supported on Windows via pip**. Known issues include:
- MSVC compiler errors during build (`invalid numeric argument '/Wno-register'`)
- Dependency `mamba-ssm` fails to build on Windows
- NVIDIA recommends Docker containers for NeMo

The release workflow runs on `windows-latest`, so if any NeMo transitive dependency requires compilation from source, the build will fail.

**Mitigation:** Pre-built wheels exist for most NeMo dependencies on Windows. As long as `uv sync` resolves to pre-built wheels only, installation works. But this is fragile and could break with any NeMo version bump.

---

## 6. Model Downloads on First Run

Models are **not bundled** in the installer. They download from Hugging Face on first use. The app now surfaces a first-run download state with size estimates and retry guidance.

| Engine | Default Model | Download Size | Cache Location |
|--------|--------------|---------------|----------------|
| Nemotron | `nvidia/nemotron-speech-streaming-en-0.6b` | ~2.47 GB | `~/.cache/huggingface/hub/` |
| Whisper | `large-v3-turbo` (CTranslate2 format) | ~1.6 GB | `~/.cache/huggingface/hub/` |

### Implications for End Users

- **First-run delay**: 1-10 minutes depending on internet speed (UI shows downloading state)
- **Internet required**: No offline-only first run possible
- **Disk space**: Models persist in user's HuggingFace cache (~2-4 GB additional)
- **Network errors**: Server has fallback to `local_files_only=True` on TLS/network errors, but this only works if the model was previously downloaded
- **Firewall/proxy**: Corporate environments may block Hugging Face (huggingface.co)

### Potential Improvements

- Bundle the default model in the installer (adds ~1.6-2.5 GB to installer size)
- Add a first-run setup wizard that downloads the model with progress indication
- Add offline model import (point to a local model directory)

---

## 7. GPU Memory (VRAM) Requirements

From `server/src/transcription/vram.py`:

| Engine | Base VRAM | Growth Rate | Min Recommended | Typical Usage |
|--------|-----------|-------------|-----------------|---------------|
| Nemotron | 5.0 GB | 100 MB/sec of audio | 8.0 GB | 5-8 GB for short recordings |
| Whisper (fp16) | 3.1 GB | 57 MB/sec of audio | — | ~2.5 GB (benchmarked) |
| Whisper (int8) | ~2.0 GB | ~40 MB/sec of audio | — | ~1.5 GB (benchmarked) |

The server has VRAM-aware engine selection: if Nemotron is selected but VRAM is below 8 GB, it auto-falls back to Whisper (unless the user explicitly chose Nemotron).

### GPU Compatibility Quick Guide

| GPU | VRAM | Whisper | Nemotron |
|-----|------|---------|----------|
| GTX 1050/1650 (4 GB) | 4 GB | Yes (int8) | No (auto-fallback) |
| GTX 1060/1660 (6 GB) | 6 GB | Yes | Marginal (short recordings) |
| RTX 3060/4060 (8 GB) | 8 GB | Yes | Yes |
| RTX 3070/4070 (8-12 GB) | 8-12 GB | Yes | Yes (comfortable) |
| RTX 3080/4080+ (12-16 GB) | 12-16 GB | Yes | Yes (long recordings) |

---

## 8. Complete End-User Dependency Checklist

### For the README / GitHub Release page

```
System Requirements:
  - Windows 10 or Windows 11 (64-bit)
  - 8 GB RAM (minimum 4 GB)
  - ~7-12 GB free disk space (app payloads + models)
  - Internet connection (nsis-web install + first-run model download)

For GPU acceleration (recommended):
  - NVIDIA GPU with 4+ GB VRAM
  - NVIDIA driver version 525 or newer
  - GPU acceleration is automatic; no CUDA toolkit install needed
    (CUDA libraries are bundled with the app via PyTorch)

CPU-only mode:
  - Works on any system, no GPU required
  - Transcription will be slower (~3-10x real-time vs ~50-90x on GPU)

Note: The Visual C++ Redistributable is required. It's pre-installed on
most Windows 10/11 systems. The app warns if it's missing and links to:
https://aka.ms/vs/17/release/vc_redist.x64.exe
```

---

## 9. Status Summary

### Completed in the current release pipeline

1. Release workflow installs engines with `uv sync --extra all`
2. nsis-web packaging avoids the 2GB limit and ships payload artifacts with releases
3. Runtime diagnostics warn about missing VC++ Redistributable, CUDA DLLs, or outdated drivers
4. First-run model download UX includes status messaging and retry guidance
5. System requirements documented for installer + model download behavior

### Remaining opportunities

1. Offline model bundling option for air-gapped or enterprise deployments
2. Optional smaller whisper-only build with clear GPU limitations
3. Additional CUDA DLL verification or auto-repair

---

## 10. Sources

- [python-build-standalone documentation](https://gregoryszorc.com/docs/python-build-standalone/main/)
- [CTranslate2 installation guide](https://opennmt.net/CTranslate2/installation.html)
- [faster-whisper GPU requirements](https://github.com/SYSTRAN/faster-whisper#requirements)
- [NVIDIA CUDA compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/)
- [NeMo Framework installation](https://docs.nvidia.com/nemo-framework/user-guide/25.04/installation.html)
- [electron-builder NSIS docs](https://www.electron.build/nsis.html)
- [NSIS 2GB limit issue](https://github.com/electron-userland/electron-builder/issues/8399)
- [PyTorch CUDA 12.4 wheels](https://download.pytorch.org/whl/cu124)
- [NVIDIA cuBLAS pip package](https://pypi.org/project/nvidia-cublas-cu12/)
