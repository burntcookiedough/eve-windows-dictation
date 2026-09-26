# Eve lean runtime blast-radius review

Status: updated 2026-09-26. This began as a design review on 2026-09-25. Since then, a local CPU candidate and a manager-installed optional GPU-pack candidate have been built and exercised; the release verifier and app/server checks passed. The production GPU-pack descriptor remains unset, and no lean-runtime installer or GPU pack has been published. Clean-machine and release/legal gates remain open. Paths below refer to the current checkout.

## What changes

The local CPU release candidate omits PyTorch and bulk CUDA libraries. The app can validate a build-matched GPU DLL pack, pass its directory to a managed Python server, and report pack integrity separately from CTranslate2 GPU capability. Pack downloads remain disabled in production while the pinned descriptor is unset. The change crosses settings persistence, native DLL loading, server adoption, renderer IPC, installer upgrades, and protected release assets.

## Facts proved with real code

| Fact | Proof | Limit |
| --- | --- | --- |
| CPU engine import and inference work without PyTorch | The release verifier requires `faster_whisper` and `ctranslate2` and asserts that `torch` is absent; the final bundled-Python CPU smoke transcribed a synthetic clip in 1.17 seconds with GPU discovery disabled. | This host had an NVIDIA driver; a clean no-driver machine was not tested. |
| GPU capability detection does not depend on PyTorch | `detect_gpu_capabilities` queries CTranslate2 and optional `nvidia-smi`; `server/tests/test_vram_capabilities.py` asserts that no Torch import occurs. | Capability detection alone does not prove model inference or driver compatibility. |
| Requested CUDA preferences survive CPU fallback and partial settings updates | `Settings` retains requested device/precision for serialization while projecting compatible runtime values; regression coverage is in `server/tests/test_backend_hardening.py`. | This verifies saved values and synthetic settings, not upgrade behavior on a real profile. |
| The Windows server registers an explicit GPU-pack directory before native imports | `server/src/runtime_paths.py` validates and registers `MURMUR_GPU_RUNTIME_DIR`; the source-matched candidate completed synthetic CUDA transcription with the manager-installed pack. | The production descriptor is unset; this does not prove public download or clean-machine support. |
| Healthy-server adoption checks app, server, and pack identity | Health fingerprints include `pack_id`; `matchesExpectedRuntime` requires exact app/server/pack identity before adoption. | Older servers without a fingerprint are refused; they are not proven compatible with the candidate. |
| Release controls verify the prepared CPU artifact | `scripts/release-verify.ps1` rejects Torch and unpinned CUDA DLLs, checks the bundled runtime, and starts the packaged server; the final candidate passed the verifier. | This does not test public pack distribution, clean-machine install, upgrade, or rollback. |

## Open release risks and required checks

| Risk | Evidence | Likelihood / cost | Before release |
| --- | --- | --- | --- |
| The optional GPU pack is not available to production users | `app/src/main/services/gpu-pack-manager.ts` leaves `PINNED_GPU_PACK_DESCRIPTOR` unset; the local pack is only a candidate. | Certain / release blocker | Complete the pinned asset, redistribution review, and release allowlists before enabling downloads. |
| Clean CPU behavior without an NVIDIA driver is unproven | CPU smoke forced GPU discovery off on a host that has an NVIDIA driver (`docs/architecture/eve-lean-runtime-release-plan.md`). | Medium / high | Run the packaged CPU lifecycle on a clean Windows host without an NVIDIA driver. |
| In-place upgrade, rollback, and uninstall behavior remain untested on synthetic profiles | Local candidate evidence does not include those lifecycle paths. | Medium / high | Add isolated upgrade, rollback, and removal/retention checks before release. |
| The existing turbo default is too slow for ordinary short CPU dictation | The packaged CPU benchmark measured end-of-speech delays with turbo (`docs/architecture/eve-cpu-dictation-benchmark.md`). | High / product quality | Select a measured CPU first-run model and evaluate real-microphone accuracy before release. |

## Cleared and still unproven

The server still checks PID, creation time, executable path, and command line before termination or adoption (`app/src/main/services/server-manager.ts`). Runtime identity checks now include the active pack, and the Windows startup hook registers only the validated pack directory before server imports. The `nsis-web` app identity and GUID remain unchanged (`app/package.json`).

The central safety claim—**a smaller CPU installer with reliable CPU dictation and optional NVIDIA inference**—is still **unproven as a release**. Local evidence now includes packaged CPU transcription, manager-installed GPU-pack CUDA transcription, and candidate release-verifier success (`docs/architecture/eve-lean-runtime-release-plan.md`). The pack is not enabled for production downloads, and clean-machine CPU/GPU, legal, upgrade, and rollback gates remain open. Keep release behavior unchanged until those gates pass.
