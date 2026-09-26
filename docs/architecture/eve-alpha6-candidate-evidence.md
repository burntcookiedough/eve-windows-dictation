# Eve v0.8.2-alpha.6 candidate evidence

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

The full server suite passed 294 tests. The first full app run had one failure and one error; a captured repeat passed 312 tests. The initial failure was not diagnosed, so the candidate PR's independent CI run remains a required check.

## Remaining gates

- Rebuild the final package from the accepted exact source head after release-preparation changes are reviewed.
- Run clean Windows without an NVIDIA driver, using a disposable runner and the published alpha.5 baseline for install, upgrade, rollback, uninstall, CPU transcription, and profile preservation.
- Resolve NVIDIA redistribution method and notices before enabling a production GPU-pack descriptor. The reproducible local GPU pack remains an unpublished candidate.
- Review the final package footprint, installer visuals, artifact manifest, checksums, CI, and CodeRabbit results before any merge, tag, upload, or publication decision.
