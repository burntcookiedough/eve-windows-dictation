# Eve lean runtime blast-radius review

Status: design review, 2026-09-25. Three independent Luna reviewers examined the proposed CPU base and optional GPU pack. No GPU pack or new installer was built. Paths below refer to the current checkout.

## What changes

The default release would omit PyTorch and CUDA libraries. Electron would download and validate a build-matched GPU DLL pack only on request, pass its directory to a managed Python server, and report pack integrity separately from CTranslate2 GPU capability. This crosses settings persistence, native DLL loading, server adoption, renderer IPC, installer upgrades, and protected release assets.

## Facts proved with real code

| Fact | Proof | Limit |
| --- | --- | --- |
| PyTorch-free engine module import works | With `torch` absent, importing `WhisperEngine` succeeded. | No transcription was performed. |
| Current GPU status is not a reliable Torch-free capability check | Pinned CTranslate2 4.6.3 returned one CUDA device, while Eve's `detect_gpu_capabilities('auto')` returned unavailable: `PyTorch is not installed`. | A device count does not prove complete GPU inference or driver compatibility. |
| Saved CUDA settings can damage unrelated settings | A temporary file with CUDA, model `small`, beam `7` loaded as `auto`, `large-v3-turbo`, beam `1` when CUDA was forced unavailable. A subsequent update rewrote that file to only `{"whisper_beam_size": 3}`. | Probe used synthetic settings, not user data. |
| The current Windows DLL helper can register a directory before imports | A bundled Windows Python probe showed `PATH` prepended, `AddDllDirectory` handle retained, and second call idempotent. `main.py` invokes it before engine imports. | It currently searches only `torch/lib`, not an external pack. |
| A healthy response lacks pack identity | The real Electron health parser accepted `{ "healthy": true, "version": "0.8.2-alpha.5" }`. | A matching runtime fingerprint is not implemented. |
| Current release gates enforce current artifacts | `uv run --no-sync pytest tests/test_gate6c_release_controls.py -q` passed 10 tests, including an asset-size mismatch case. | It does not test a GPU pack, upgrade, or rollback. |

## Confirmed risks and required checks

| Risk | Evidence | Likelihood / cost | Before release |
| --- | --- | --- | --- |
| CPU-first upgrade can discard saved preferences after a later settings write | `server/src/config.py:154-163,403-493`; synthetic probe above | Medium / high | Preserve requested values; test load and unrelated update under unavailable CUDA. |
| GPU diagnostics can say unavailable while CTranslate2 sees a device | `server/src/transcription/vram.py:66-76`; `server/src/transcription/engines/whisper.py:132-140` | High / medium | Use CTranslate2 as runtime authority; test diagnostics and actual GPU inference without Torch. |
| Activated pack can be ignored by a healthy adopted CPU server | `app/src/main/services/server-manager.ts:422,533,853`; health-parser probe above | Medium / high | Add build/pack fingerprint and test already-running owned and unmanaged servers; retain process-ownership checks. |
| GPU repair control can disappear when Python server is down | `app/src/renderer/app/views/SettingsView.svelte:832`; `app/src/main/ipc/handlers.ts:34` | Medium / medium | Put pack state/install in main IPC and test with server stopped. |
| CPU base or new asset fails existing release gates | `scripts/release-verify.ps1:174-175,214`; `scripts/release-artifacts.ps1:17-25`; `.github/workflows/release.yml:112-122,203-213` | Certain / release blocker | Reverse Torch assertion for CPU; add pack to exact manifests/allowlists and checksums; test tampering. |
| Existing smoke misses in-place upgrade and uninstall footprint | `scripts/installer-smoke.ps1:160-170`; `app/package.json:118` | Certain gap / high | Add isolated upgrade, rollback, and removal/retention checks. |
| Pack may exceed asset ceiling or lack distribution clearance | `scripts/release-artifacts.ps1:23-25`; DLL set and compressed bytes unmeasured | Unknown / release blocker | Measure real archive; inspect dependencies; review each redistributable and notices. |

## Cleared and still unproven

The current server ownership checks use PID, creation time, executable path, and command line before termination or adoption (`server-manager.ts:192,536,823`). Preserve that boundary when adding fingerprint checks. The current `nsis-web` app identity and GUID can remain unchanged (`app/package.json:79-80,111-119`). The Windows startup hook runs before server imports and can be adapted to a validated pack directory.

The central safety claim—**a much smaller CPU installer with stable CPU dictation and optional real NVIDIA inference**—is still **unproven as a release**. A [separate local proof](eve-gpu-pack-provenance.md) now shows that a verified NVIDIA cuBLAS pair can transcribe one synthetic sample with CUDA, but there is no compressed candidate installer, installed-directory measurement, final legal review, clean-machine test, or end-to-end app dictation. Keep release behavior unchanged until those gates pass.
