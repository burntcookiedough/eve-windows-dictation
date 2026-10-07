# Eve lean runtime release plan

> **Release controls and gate specification**: This document defines packaging controls, verification gates, and footprint accounting for the lean runtime architecture (CPU base + optional NVIDIA GPU pack), referenced by [building](../development/building.md). The candidate measurements recorded below reflect the initial 2026-09-25 evaluation; Eve v0.8.2-alpha.8 is now published. Controls remain active; this document does not authorize any new release action.

Status: packaging controls and historical candidate measurements. This plan governs the CPU default and optional NVIDIA runtime. It does not authorize a tag, upload, publication, or mutation of historical release assets.

## Scope and boundaries

The default `nsis-web` artifact must contain a self-contained Windows Python runtime, Faster-Whisper, and CTranslate2, but no PyTorch package or bulk CUDA DLL closure. The exact pinned CTranslate2 cuDNN dispatcher is the retained exception, verified by hash as described in the candidate evidence below. Quick and Long dictation, history, hotkeys, local processing, settings, and frozen Eve/Murmur compatibility surfaces remain supported. NVIDIA acceleration is an explicit optional download bound to the app and CTranslate2 build, installed only after exact integrity validation and legal review. Model weights remain a separate download using existing cache behavior.

Retain AppUserModelID `io.github.burntcookiedough.eve`, NSIS GUID `0204d005-75b3-5b31-b1f6-ef2831e2b204`, `nsis-web`, Eve and preserved Murmur profiles, internal `murmur` protocol/environment names, install chain, and release identities. Do not inspect or change personal audio, transcripts, settings, caches, clipboard, credentials, or legacy profile contents. Use synthetic QA profiles and clean test caches only.

## Retained release gates

1. **Feasibility.** Identify the exact pinned CTranslate2 GPU native dependencies and allowed redistribution inputs. A [local candidate proof](eve-gpu-pack-provenance.md) has verified two cuBLAS DLLs against NVIDIA's archive and completed one isolated synthetic GPU transcription. Still prove short and long NVIDIA dictation on clean Windows without an installed CUDA Toolkit, review final redistribution terms, and record final notices. A device count or import test is insufficient.
2. **CPU base.** Keep Torch outside the release dependency closure and use runtime capability probes. Preserve persisted requested settings and derive an effective CPU fallback without rewriting preferences. Build from a clean Windows environment and prove no Torch or bulk CUDA files are installed, allowing only the exact verified CTranslate2 dispatcher. Run CPU transcription with no NVIDIA driver.
3. **Pack lifecycle.** Main owns a trusted app-pinned descriptor, explicit download, archive/member validation, immutable publication, compatible selection, and retention. Python loads only a validated directory before native imports. Health reports a runtime fingerprint. Renderer can show and repair pack state even if Python is down. Prove corrupt, truncated, wrong-version, traversal, interruption, repeat-install, stale-server, restart, upgrade, rollback, and uninstall behavior.
4. **Release candidate.** From an accepted exact head, build one fresh `nsis-web` candidate and matching optional pack, measure compressed archive, installed directory, and separate clean model-cache bytes. Update exact asset manifest, protected workflow allowlists, release verifier, third-party notices, and tests. Run clean CPU and NVIDIA lifecycle tests, including in-place upgrades using synthetic profiles. Stop on any failed gate.
5. **Publication.** Requires a separate exact-head review and user approval after all prior evidence is available. Do not create or move a tag or release draft during implementation.

The previously published v0.8.2-alpha.4 release plan and Gate 6 evidence are historical and remain unchanged. These retained gates do not retroactively approve a change for an older candidate or authorize a new release.

## Acceptance evidence

Publish a table with baseline and candidate `nsis-web` payload bytes, installed bytes, model-cache or published model-weight bytes, startup time, CPU Quick/Long results, GPU Quick/Long results, and rollback outcome. The raw Python closure reduction measured in the design is not an installer target. Keep the existing release behavior if the GPU pack cannot meet the feasibility or legal gate.

### Historical local implementation evidence (2026-09-25)

The first isolated `nsis-web` CPU candidate built without a Torch or NVIDIA package directory. Its downloadable `.7z` payload was **178,038,513 bytes**; the web setup stub was **654,583 bytes**; the unpacked application directory was **695,799,321 bytes** after signing. The release Python `site-packages` tree was **296,214,560 bytes**. These are local candidate measurements, not a comparison with a historical compressed installer. The isolated public tiny-model cache used for synthetic transcription was **78,203,659 bytes** and is separate from the installer. A synthetic speech clip transcribed with the candidate's bundled Python and CTranslate2 on CPU in **1.39 seconds**, including model load. The test host has an NVIDIA driver; `CUDA_VISIBLE_DEVICES=-1` forced the CPU path, so this is not yet a no-driver clean-machine test.

The final source-matched CPU candidate measured **178,039,346 bytes** for the `.7z` payload, **654,598 bytes** for the setup stub, and **685,806,043 bytes** unpacked. The pinned CTranslate2 wheel contains one **266,288-byte** `cudnn64_9.dll` dispatcher (SHA-256 `9edbcdff73b0af070eb160b2ce66e59feca04aa017351d8eedcc5e8e149967d2`); it is retained for the optional GPU path. The release verifier permits only this exact dispatcher and rejects other CUDA runtime DLLs in the CPU base.

The local NVIDIA proof in the provenance document loaded both cuBLAS DLLs from an isolated directory and completed synthetic transcription. It does not substitute for an installer, clean-machine, short/long dictation, license, or upgrade gate. The GPU pack is now a separate public prerelease pinned by the alpha.6 candidate descriptor; the Eve app release remains unpublished. App publication remains outside this implementation plan.

At the final source state, `uv lock --check --offline`, the app build, TypeScript check, `git diff --check`, **289 server tests**, and **298 app tests** passed. The final unpacked candidate transcribed the synthetic clip on CPU in **1.17 seconds** with GPU discovery disabled. It also transcribed on CUDA in **2.75 seconds** using the manager-installed candidate pack, with Windows module paths confirming both cuBLAS DLLs came from that pack. These are single local samples, not performance benchmarks. No historical installer upgrade or rollback was attempted on a real user profile.
