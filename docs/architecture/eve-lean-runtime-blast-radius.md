# [Historical] Eve lean runtime blast-radius review

> **Historical review evidence**: This document captures the blast-radius review and verification evidence conducted during the alpha.6 lean runtime evaluation (2026-10-02). Eve v0.8.2-alpha.8 is now published. Retained as frozen verification evidence; see the current [documentation index](../README.md) and [roadmap](../project/roadmap.md).

Status: updated 2026-10-02. The alpha.6 candidate pins the public optional GPU pack; the Eve app release remains unpublished. Hosted Windows CPU install, upgrade, rollback, uninstall, transcription, and synthetic-profile preservation passed at `a83438fed1270b97f24e686b8e2044c5a2416b5b` in [the installer lifecycle run](https://github.com/burntcookiedough/eve-windows-dictation/actions/runs/37037443453). Separate clean NVIDIA-machine evidence remains open. Licensing and notices are handled separately under the owner's scope decision. Paths below refer to the current checkout.

## What changes

The local CPU release candidate omits PyTorch and bulk CUDA libraries. The app can validate a build-matched GPU DLL pack, pass its directory to a managed Python server, and report pack integrity separately from CTranslate2 GPU capability. The alpha.6 candidate pins the public pack for explicit opt-in download. The change crosses settings persistence, native DLL loading, server adoption, renderer IPC, installer upgrades, and protected release assets.

## Facts proved with real code

| Fact | Proof | Limit |
| --- | --- | --- |
| CPU engine import and inference work without PyTorch | The release verifier requires `faster_whisper` and `ctranslate2` and asserts that `torch` is absent; hosted Windows lifecycle CI passed packaged CPU transcription without an NVIDIA driver at `a83438f`. | This proves the CI speech fixture, not physical-microphone dictation quality. |
| GPU capability detection does not depend on PyTorch | `detect_gpu_capabilities` queries CTranslate2 and optional `nvidia-smi`; `server/tests/test_vram_capabilities.py` asserts that no Torch import occurs. | Capability detection alone does not prove model inference or driver compatibility. |
| Requested CUDA preferences survive CPU fallback and partial settings updates | `Settings` retains requested device/precision for serialization while projecting compatible runtime values; regression coverage is in `server/tests/test_backend_hardening.py`. | This verifies saved values and synthetic settings, not upgrade behavior on a real profile. |
| The Windows server registers an explicit GPU-pack directory before native imports | `server/src/runtime_paths.py` validates and registers `MURMUR_GPU_RUNTIME_DIR`; the source-matched candidate completed synthetic CUDA transcription with the manager-installed pack. | The alpha.6 descriptor now pins the public pack; this does not prove clean-machine support. |
| Healthy-server adoption checks app, server, and pack identity | Health fingerprints include `pack_id`; `matchesExpectedRuntime` requires exact app/server/pack identity before adoption. | Older servers without a fingerprint are refused; they are not proven compatible with the candidate. |
| Release controls verify the prepared CPU artifact | `scripts/release-verify.ps1` rejects Torch and unpinned CUDA DLLs, checks the bundled runtime, and starts the packaged server; the final candidate passed the verifier. | This does not test public pack distribution, clean-machine install, upgrade, or rollback. |
| CPU installation preserves the synthetic profile across upgrade, rollback, and uninstall | The hosted lifecycle run installed published alpha.5, upgraded to the exact `a83438f` alpha.6 candidate, rolled back, and checked profile retention. | This does not inspect personal profiles or prove the separate GPU-pack lifecycle on a clean NVIDIA host. |

## Open release risks and required checks

| Risk | Evidence | Likelihood / cost | Before release |
| --- | --- | --- | --- |
| The optional GPU-pack download requires the unpublished alpha.6 app | The public pack is pinned by `PINNED_GPU_PACK_DESCRIPTOR` in the alpha.6 candidate, but the Eve app release is not published. | Certain until app release / availability | Complete app release checks and publish the alpha.6 app through its release workflow. |
| Clean NVIDIA installation without a global CUDA Toolkit remains unproven | Public HTTP install, restart, CUDA transcription, and CPU fallback passed in an isolated unpacked-app preflight on a host with an NVIDIA driver and Toolkit. No separate clean GPU host was available. | Medium / compatibility | Run the installed candidate's GPU-support flow on a separate NVIDIA Windows host without a Toolkit. |
| Existing CPU profiles can retain a slow turbo choice | The `small` default is seeded only for empty profiles; existing profiles keep saved choices or the historical `large-v3-turbo` default (`docs/architecture/eve-cpu-first-run-decision.md`). The packaged CPU benchmark measured slow turbo finalization (`docs/architecture/eve-cpu-dictation-benchmark.md`). | Medium / usability | Measure Quick and Long dictation for existing CPU profiles and offer a model recommendation if the delay remains. |
| Fresh-profile `small` accuracy is not established for real microphones | The CPU first-run decision uses read LibriSpeech excerpts and synthetic speech, not physical-microphone samples (`docs/architecture/eve-cpu-first-run-decision.md`). | Medium / product quality | Evaluate representative real-microphone clips before making accuracy claims against turbo. |

## Cleared and still unproven

The server still checks PID, creation time, executable path, and command line before termination or adoption (`app/src/main/services/server-manager.ts`). Runtime identity checks now include the active pack, and the Windows startup hook registers only the validated pack directory before server imports. The `nsis-web` app identity and GUID remain unchanged (`app/package.json`).

The CPU installer and synthetic-profile lifecycle are proven in hosted Windows CI. Optional NVIDIA inference and public pack installation are proven as unpacked-app preflight; the separate clean GPU-machine scenario is unproven. The production descriptor is enabled and pins the published assets. These facts do not authorize merging PRs or publishing the Eve app release. Final integrated-head checks and review must pass before a merge decision.
