# Eve GPU pack candidate: provenance and functional proof

Status: local candidate, 2026-09-25. No binary is committed, hosted, or released. This record does not by itself clear redistribution or replace a clean-machine installer test.

## Source and exact files

The source is NVIDIA's [CUDA 12.9.1 redistributable manifest](https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.1.json) and its `libcublas/windows-x86_64/libcublas-windows-x86_64-12.9.1.4-archive.zip` asset. The archive is **549,755,186 bytes**; its SHA-256 is `d534d98b0b453a98914dbf3adf47d7e84b55037abf02f87466439e1dcef581ed`, matching the official manifest after download. The two local CUDA Toolkit DLLs used in the functional probe matched the corresponding members of this verified archive byte for byte by SHA-256.

| Member | Raw bytes | Raw SHA-256 | Local Brotli quality-5 bytes | Brotli SHA-256 |
| --- | ---: | --- | ---: | --- |
| `cublas64_12.dll` | 102,518,272 | `90052a83efd1b57a8e3616a6590b335855f81b814a4f16eecb7b5bf6d1b1d4eb` | 68,190,827 | `bf44b669968ee3e660579fb0a8e436b809e075f07d3b296b017f4ca559752528` |
| `cublasLt64_12.dll` | 668,669,952 | `c3a05ea244c937314afec09f87b91f814c7e27977681f6c67eb51bb06ced3a4a` | 426,759,202 | `6b73b5a5125812b4b0be61ce2dfa183baac6451097ebd07466c9d264e01a446d` |

The pair is **771,188,224 raw bytes** and **494,950,029 bytes** in two locally generated Brotli files. These are candidate pack bytes, not a GitHub release asset or complete installed-app size. The official ZIP also includes `nvblas64_12.dll`; it was not present in the functional load path and is excluded from this Whisper-specific candidate. The installed CTranslate2 4.6.3 wheel supplies `cudnn64_9.dll` as a small dispatcher. Its optional cuDNN component DLLs were absent; this probe loaded the dispatcher but did not load those components.

## Functional probe

Using the pinned local Python 3.11 CPU closure, Faster-Whisper 1.2.1, and CTranslate2 4.6.3, a test process loaded the public `tiny` model into an isolated test directory and transcribed a synthetic Windows speech sample on `device='cuda'`, `compute_type='float16'`. CTranslate2 reported `model.model.device == 'cuda'`, and the generated sentence was transcribed. Windows `GetModuleFileNameW` confirmed that both cuBLAS DLLs loaded from the isolated candidate directory, while `nvcuda.dll` loaded from Windows System32. The test process was launched with a clean `PATH` that excluded the installed CUDA Toolkit, and CUDA Toolkit environment hints were removed before launch. No existing user model cache, recording, transcript, or profile was read.

An initial probe that changed `PATH` *after* Python started loaded both DLLs from the installed CUDA Toolkit. That result was rejected as isolation evidence. The clean-process rerun loaded the candidate copies and is the functional evidence above.

The result proves that this pair works for one small synthetic transcription on this NVIDIA host. It does not prove all supported hardware, long dictation, app startup, upgrades, or installation on a host without the CUDA Toolkit. Those remain release gates.

On the same date, the app's actual pack manager installed the two locally generated Brotli streams using its pinned compressed and raw size/hash checks. It published pack ID `0b916158ee267fa5b30765e3d998c6e7ea47ca42ecb59e0bddb6112b960b4061` in an isolated test root and revalidated it. The first install and second verification took 16 seconds locally. The unpacked CPU candidate's bundled Python then registered that exact managed directory before importing CTranslate2 and transcribed the same synthetic sample on CUDA in 1.62 seconds including model load. Windows reported both cuBLAS DLLs loading from the manager's installed directory. The process PATH was sanitized before launch and excluded the installed CUDA Toolkit. This verifies the manager-to-packaged-Python seam locally; it still is not a clean-machine installer or a public download test.

## Distribution boundary

NVIDIA's [CUDA 12.9 EULA](https://docs.nvidia.com/cuda/archive/12.9.0/eula/index.html) lists Windows cuBLAS/cuBLASLt runtime files as redistributable under conditions on application use and non-standalone distribution. The final Eve-specific download, notices, download URL, and access pattern need review against those terms. The candidate pack manager must pin each compressed and decompressed hash in the base app; a manifest downloaded beside the assets is not a trust root.
