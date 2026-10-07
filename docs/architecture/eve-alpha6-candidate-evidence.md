# [Historical] Eve v0.8.2-alpha.6 candidate evidence

> **Historical candidate evidence**: This document records local preflight and candidate verification evidence for the v0.8.2-alpha.6 milestone. Eve v0.8.2-alpha.8 is now published. Retained as frozen measurement evidence; see the current [documentation index](../README.md) and [roadmap](../project/roadmap.md).

Status: local preparation, not a published release. The candidate branch depends on PRs #87 and #88. This record distinguishes the local package preflight from the final exact-head release candidate.

## Local package preflight

The first alpha.6 `nsis-web` package was built from the version-preparation source at `6bfdd25` with `bun run package:win` (`--publish never`). It was not installed through the Windows installer. The package used the Windows release-only Faster-Whisper/CTranslate2 dependency closure and a prepared relocatable Python 3.11 runtime.

| Observation | Result |
| --- | ---: |
| Web installer payload | 178,040,364 bytes |
| Web setup wrapper | 654,579 bytes |
| Unpacked application after packaged-server verification | 701,160,146 bytes |
| Generated `.pyc` files in that unpacked directory | 15,346,463 bytes |
| Inferred unpacked size before `.pyc` generation | 685,813,683 bytes |

The first release-verifier invocation used relative `-InstallDir` and failed its cuDNN-dispatcher exclusion because it compared a relative path with an absolute path. Commit `0e4c2b9` normalizes both input paths. Relative and absolute invocations then passed: repository version/merge checks, artifact names, the no-Torch/no-bulk-CUDA package scan, self-contained runtime validation, packaged Faster-Whisper catalog, and packaged server health (`0.8.2-alpha.6`, ready `tiny` model). The verifier started only the task-local unpacked server on port 18765.

The packaged Python runtime transcribed the repository's 47.33-second test WAV using public `tiny` weights in a task-local model cache. It reported `device=cpu`, 12 segments, nonempty text, and no loaded `cublas64_12.dll` or `nvcuda.dll`. This host has an NVIDIA driver; the result is not a clean no-driver machine test. No microphone, overlay, clipboard insertion, installer upgrade, or rollback was exercised in this local preflight.

Earlier preflight runs passed 294 server tests and, on one captured repeat, 312 app tests. Other local app runs failed rendered Electron fixtures; those runs are not a claim that the complete local app suite passes today.

The optional GPU-pack preflight used a later unpacked Eve package built from a working tree based on `3e7a44e` with the production descriptor change subsequently committed at `dda2b9d`. Its public Settings download, restart, CUDA transcription, and no-pack CPU fallback passed in isolated profiles. That unpacked package was not installed through NSIS or rebuilt from the exact `dda2b9d` commit. See [GPU-pack provenance](eve-gpu-pack-provenance.md).

## October 2 review evidence

Commit `a83438fed1270b97f24e686b8e2044c5a2416b5b` fixes valid apostrophes in Windows GPU-runtime paths. Its registration regression failed before the fix and passed afterward; the full local server suite passed 298 tests. Local app build, main-process TypeScript, and history checks passed. The full local app run passed 303 tests and failed two rendered fixtures; focused History export passed, while Settings capture reproduced `Current display surface not available for capture`. The first startup failure was not reproduced or classified. [Hosted app/server CI](https://github.com/burntcookiedough/eve-windows-dictation/actions/runs/37037443509) passed on this commit.

The [hosted Windows lifecycle run](https://github.com/burntcookiedough/eve-windows-dictation/actions/runs/37037443453) passed CPU installation, published alpha.5 upgrade, rollback, uninstall, transcription, and synthetic-profile preservation at the same head. The September 27 installer visual artifact at `da7f7ae` was inspected on October 2: the Eve Setup text was readable and desktop/Start-menu shortcuts targeted `Eve.exe`; the icon had weak contrast on light backgrounds. [New-head visual capture](https://github.com/burntcookiedough/eve-windows-dictation/actions/runs/37037443466) also passed; capture success alone is not visual approval.

## Remaining gates

- Rebuild the final Eve app package from the accepted exact source head before an app release decision.
- The hosted no-NVIDIA-driver lifecycle CI passed install, upgrade, rollback, uninstall, CPU transcription, and profile preservation against the published alpha.5 baseline. A separate clean Windows GPU machine without a CUDA Toolkit remains untested.
- The reproducible GPU pack is now published as a public prerelease and pinned by the alpha.6 candidate descriptor. The Eve app release remains unpublished.
- Review the final package footprint, installer visuals, artifact manifest, checksums, CI, and CodeRabbit results before any Eve app merge, tag, upload, or publication decision.
