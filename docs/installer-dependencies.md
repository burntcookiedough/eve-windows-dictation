# Eve installer: end-user dependency research

> Research date: February 2026
> Scope: what a Windows user needs when downloading Eve from GitHub Releases.

## Executive summary

The `nsis-web` installer contains the Electron client and a self-contained Python
runtime. Eve currently ships one speech model family: Faster-Whisper through the
CTranslate2 adapter. The `release` dependency closure adds the locked CUDA-enabled
PyTorch runtime needed for GPU support. Model weights are downloaded on first run,
not embedded in the installer.

The release verifier checks the actual prepared payload: Faster-Whisper and PyTorch
must be importable, retired model-runtime packages and source modules must be absent,
and the bundled Python runtime must be self-contained. It does not import or discover
an unsupported model family.

## 1. What the installer bundles

The `bun run package:win` command targets `nsis-web`. The small web installer downloads
payload archives during installation; the payload contains:

| Component | Source | Approximate size |
| --- | --- | ---: |
| Electron/Chromium runtime | `app/dist/` | 150–200 MB |
| Eve resources | `app/resources/` | <1 MB |
| Native Node modules | Electron-rebuilt `app/node_modules/` | ~10 MB |
| Python interpreter | `server/.runtime/python.exe` | ~100 MB |
| Python packages | `server/.venv/Lib/site-packages/` | Depends on the release closure |
| Server source | `server/src/` | ~100 KB |

Build filters exclude bytecode, package-manager tooling, dependency tests, static
linker archives, PyTorch headers, and standalone-Python development assets. They do
not remove runtime DLLs needed by Faster-Whisper or CUDA.

The installer does not contain:

- model weights (downloaded from Hugging Face on first use);
- a system CUDA Toolkit or separate cuDNN installation;
- Visual C++ Redistributable; or
- NVIDIA GPU drivers.

## 2. End-user requirements

| Requirement | Details |
| --- | --- |
| Windows | Windows 10/11, x86_64 |
| Disk | Plan for roughly 5–8 GB for the app and 2–4 GB for model caches |
| RAM | 4 GB minimum; 8 GB or more recommended |
| Internet | Required for `nsis-web` payloads and first-use model download |
| Visual C++ Redistributable | Required by Electron native modules and Python extensions; Eve links to the official installer when missing |

CPU mode works without a GPU. For acceleration, use a CUDA-capable NVIDIA GPU with
a current driver (CUDA 12.4 compatibility requires a driver in the supported range)
and enough VRAM for the selected model and audio length. The adapter reports the
effective device and precision at runtime; `auto` is the safest default.

## 3. Self-contained Python runtime

Release preparation runs:

```powershell
Set-Location server
uv sync --python 3.11 --no-dev --extra release --frozen
../scripts/prepare-python-runtime.ps1 -ServerDir .
```

The managed Python build is copied to `.runtime`; third-party packages stay in
`.venv/Lib/site-packages`. The packaged launcher sets:

```text
PYTHONPATH={resources}/server/.venv/Lib/site-packages
{resources}/server/.runtime/python.exe {resources}/server/src/main.py
```

`prepare-python-runtime.ps1` verifies that the synced virtual environment and the
managed interpreter have the same Python ABI before copying. Release verification
then probes `sys.prefix`, `sys.path`, and the executable to ensure they resolve inside
the bundled runtime.

## 4. CUDA runtime and diagnostics

The release extra currently includes `torch==2.6.0+cu124` from the explicit PyTorch
CUDA index and Faster-Whisper/CTranslate2 from PyPI. PyTorch supplies the CUDA DLLs
under `torch/lib`; the Electron server launcher prepends that directory to `PATH` and
the server registers it before CTranslate2 initializes.

| Build command | GPU closure | Intended use |
| --- | --- | --- |
| `uv sync --python 3.11 --no-dev --extra release --frozen` | Faster-Whisper + CUDA PyTorch | Packaged Windows runtime |
| `uv sync --extra whisper --group dev --frozen` | Faster-Whisper without CUDA PyTorch | Development and CPU tests |
| `uv sync --group dev --frozen` | No speech runtime unless requested | General server development |

The release verifier imports `faster_whisper` and `torch`, checks that the supported
source tree contains no retired adapter modules, and rejects unsupported package
directories if they appear in the prepared site-packages directory. It also starts
the bundled server and verifies `/health`.

On startup Eve can report:

- CTranslate2 CUDA capability and DLL availability;
- CUDA device name and total VRAM;
- NVIDIA driver information from `nvidia-smi`; and
- Visual C++ Redistributable status on Windows.

These diagnostics are bounded and actionable; they do not read audio, transcripts,
clipboard contents, or private profile data.

## 5. Model downloads

Weights are separate from the runtime and remain in the user's Hugging Face cache.
The built-in catalog is presentation metadata for Faster-Whisper choices:

| Choice | Repository | Approximate size |
| --- | --- | ---: |
| `large-v3-turbo` | `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | 1.5 GB |
| `large-v3` | `Systran/faster-whisper-large-v3` | 2.9 GB |
| `medium` | `Systran/faster-whisper-medium` | 1.4 GB |
| `small` | `Systran/faster-whisper-small` | 0.5 GB |
| `tiny` | `Systran/faster-whisper-tiny` | 0.07 GB |

Advanced users may supply an explicit Faster-Whisper repository or local model path.
Before a missing or partial download, the server checks free space on the cache
filesystem, accounts for already-present required files, and reserves the larger of
10% or 512 MiB as a cushion. Partial downloads remain resumable; an unavailable or
insufficient filesystem produces a model-preparation error without deleting data.

## 6. VRAM guidance

The runtime's estimate is intentionally conservative and empirical. It uses a
3.1 GB Faster-Whisper base estimate plus roughly 57 MB per second of audio for the
selected CUDA configuration. Treat the value as a warning, not a hard hardware
requirement; actual usage depends on model, precision, driver, and concurrent GPU
work.

| GPU memory | Suggested starting point |
| ---: | --- |
| 4 GB | `tiny`, `small`, or `int8` |
| 6–8 GB | `small`, `medium`, or `large-v3-turbo` with `int8` |
| 12 GB or more | `large-v3-turbo` or `large-v3` with `float16` where supported |

If CUDA preparation fails, select `auto` or `cpu` in Settings. The current ready model
stays usable while a replacement is prepared; failed candidates are discarded.

## 7. Release checklist

Before a release-authorized package attempt, verify:

1. `uv sync --python 3.11 --no-dev --extra release --frozen` completed without lock changes.
2. `prepare-python-runtime.ps1` copied an ABI-matched managed runtime.
3. `scripts/release-verify.ps1` found Faster-Whisper and PyTorch, found no retired
   model-runtime packages or source modules, and passed the bundled `/health` check.
4. The generated third-party notice inventory matches the prepared closure.
5. Model downloads, CPU fallback, CUDA diagnostics, model replacement, and Quick/Long
   Dictation are covered by the accepted exact-head validation plan.

Packaging, signing, tagging, uploading, and publication remain separately authorized
release actions. This document does not authorize any of them.

## Sources

- [python-build-standalone documentation](https://gregoryszorc.com/docs/python-build-standalone/main/)
- [CTranslate2 installation guide](https://opennmt.net/CTranslate2/installation.html)
- [faster-whisper requirements](https://github.com/SYSTRAN/faster-whisper#requirements)
- [NVIDIA CUDA compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/)
- [electron-builder nsis-web documentation](https://www.electron.build/nsis-web.html)
- [PyTorch CUDA 12.4 wheels](https://download.pytorch.org/whl/cu124)
