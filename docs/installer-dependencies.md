# Eve installer dependencies

> Current dependency reference for the alpha.8 source baseline. Size figures below
> retain September 2026 candidate measurements; they are not new alpha.8 artifact measurements.

## Executive summary

The `nsis-web` installer contains the Electron client and a self-contained Python
runtime. Eve currently ships one speech model family: Faster-Whisper through the
CTranslate2 adapter. The `release` closure is CPU-capable and omits
PyTorch. The optional two-DLL NVIDIA pack is hosted as a separate prerelease and
pinned by the app's descriptor; installation is an explicit Settings action. See
[GPU-pack provenance](architecture/eve-gpu-pack-provenance.md) for exact bytes,
hashes, and the limits of the recorded hardware evidence. Model
weights are downloaded on first run, not embedded in the installer.

The release verifier checks the actual prepared payload: Faster-Whisper and CTranslate2
must be importable, PyTorch and the bulk CUDA runtime closure and retired model modules must be absent,
and the bundled Python runtime must be self-contained. It does not import or discover
an unsupported model family.

## 1. What the installer bundles

The `bun run package:win` command targets `nsis-web`. The small web installer downloads
payload archives during installation; the payload contains:

| Component | Source | Approximate size |
| --- | --- | ---: |
| Electron/Chromium runtime | packaged Electron distribution | Included in the measured installed total |
| Compiled Eve code | `app/dist/` | 2.7 MB raw before package filters |
| Eve resources | `app/resources/` | <1 MB |
| Native Node modules | Electron-rebuilt `app/node_modules/` | ~10 MB |
| Python interpreter | `server/.runtime/` | 75.6 MB raw before package filters |
| Python packages | `server/.venv/Lib/site-packages/` | 296.2 MB raw before package filters |
| Server source | `server/src/` | ~100 KB |

Build filters exclude bytecode, package-manager tooling, dependency tests, static
linker archives, and standalone-Python development assets. They do not remove runtime
DLLs needed by Faster-Whisper. The CPU release dependency closure excludes PyTorch and
the bulk CUDA runtime at resolution time. The pinned CTranslate2 wheel contains one
266,288-byte `cudnn64_9.dll` dispatcher that remains in the base for optional GPU use;
the release verifier permits this exact hashed file only.

The installer does not contain:

- model weights (downloaded from Hugging Face on first use);
- a system CUDA Toolkit or separate cuDNN installation;
- Visual C++ Redistributable; or
- NVIDIA GPU drivers.

## 2. End-user requirements

| Requirement | Details |
| --- | --- |
| Windows | Windows 10/11, x86_64 |
| Disk | Local final candidate: 685,806,043 bytes unpacked; allow separate space for model weights and an optional GPU pack |
| RAM | 4 GB minimum; 8 GB or more recommended |
| Internet | Required for `nsis-web` payloads and first-use model download |
| Visual C++ Redistributable | Required by Electron native modules and Python extensions; Eve links to the official installer when missing |

CPU mode works without a GPU. The optional NVIDIA pack requires a supported driver
and sufficient VRAM. The pinned pack is 494,950,029 bytes compressed and
771,188,224 bytes installed. Publication does not establish support on every NVIDIA
machine; retain the hardware-evidence limits in its provenance record. The adapter reports effective device and
precision; `auto` is the safest default.

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

## 4. Optional CUDA runtime and diagnostics

Earlier releases included `torch==2.6.0+cu124` to supply CUDA DLLs under `torch/lib`.
The current release closure excludes it. Electron downloads and validates the pinned
GPU pack before passing its directory to the managed server. Python registers that
directory before CTranslate2 initializes. Pack integrity and actual GPU capability
are separate states; a saved CUDA preference does not guarantee acceleration.

| Build command | GPU closure | Intended use |
| --- | --- | --- |
| `uv sync --python 3.11 --no-dev --extra release --frozen` | CPU Faster-Whisper/CTranslate2 | Packaged Windows runtime |
| `uv sync --extra whisper --group dev --frozen` | CPU Faster-Whisper/CTranslate2 | Development and CPU tests |
| `uv sync --group dev --frozen` | No speech runtime unless requested | General server development |

The release verifier imports `faster_whisper` and `ctranslate2`, rejects Torch and CUDA
runtime DLLs other than the exact pinned CTranslate2 cuDNN dispatcher, checks that the supported
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
3. `scripts/release-verify.ps1` found Faster-Whisper/CTranslate2, rejected PyTorch/CUDA files, found no retired
   model-runtime packages or source modules, and passed the bundled `/health` check.
4. The generated third-party notice inventory matches the prepared closure.
5. Model downloads, CPU dictation, optional GPU inference, CUDA diagnostics, model
   replacement, and Quick/Long Dictation are covered by the lean-runtime release plan.

Packaging, signing, tagging, uploading, and publication remain separately authorized
release actions. This document does not authorize any of them.

## Sources

- [python-build-standalone documentation](https://gregoryszorc.com/docs/python-build-standalone/main/)
- [CTranslate2 installation guide](https://opennmt.net/CTranslate2/installation.html)
- [faster-whisper requirements](https://github.com/SYSTRAN/faster-whisper#requirements)
- [NVIDIA CUDA compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/)
- [electron-builder nsis-web documentation](https://www.electron.build/nsis-web.html)
- [PyTorch CUDA 12.4 wheels](https://download.pytorch.org/whl/cu124)
