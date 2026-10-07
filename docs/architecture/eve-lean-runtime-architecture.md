# Eve lean runtime architecture

> **Architecture reference and historical proposed design**: The CPU base and
> build-matched optional GPU pack remain the distribution model. The design
> sketches and migration findings below record the initial candidate; they are
> not current interface definitions. For implemented runtime behavior, refer to:
> - [Speech-model selection](../speech-model-selection.md)
> - [Installer dependencies](../installer-dependencies.md)
> - [Building and packaging](../development/building.md)

Status: architecture reference and candidate design. Companion to [the System Design document](eve-lean-runtime-system-design.docx), [measured plan](eve-lean-runtime-plan.md), [blast-radius review](eve-lean-runtime-blast-radius.md), and [GPU pack provenance record](eve-gpu-pack-provenance.md).

The current [GPU pack manager](../../app/src/main/services/gpu-pack-manager.ts)
pins two Brotli assets with compressed and decompressed hashes. The archive/member
descriptor sketched below is historical. The production pack supplies cuBLAS DLLs;
the base retains the exact pinned CTranslate2 cuDNN dispatcher. The provenance record
retains the hardware-validation limits separately from download availability.

## Caller view

The default Windows install starts a CPU server and supports Quick and Long dictation with no NVIDIA driver. Settings can show the optional GPU pack's exact download size and integrity state, even if the Python server is unavailable. A user explicitly starts a download. An installed pack becomes usable on the next managed server start; only a successful CTranslate2 capability probe can report GPU availability.

```ts
const state = await window.murmurMain.getGpuPackState();
const unsubscribe = window.murmurMain.onGpuPackStateChange(showGpuPackState);
await window.murmurMain.installGpuPack(); // explicit user action
```

The renderer receives neither URL nor filesystem path. It displays pack integrity separately from actual GPU capability and from the user's requested device. A saved `cuda` preference remains saved if the current machine can only run CPU; the effective fallback and reason are visible.

## Decision and synthesis

Choose a CPU base plus a separately downloaded, immutable, build-matched CUDA/cuDNN DLL pack. Electron owns acquisition, integrity checking, and runtime selection. Python owns CTranslate2 capability and effective device selection. The base app's pinned descriptor, rather than a manifest fetched with the archive, is the trust root. Activate only a pack whose archive and every member have passed exact checks. Select by build/pack identity on each start rather than relying solely on a mutable active pointer.

The structurally different alternative is two complete installer editions. It reuses the current GPU closure but retains the multi-gigabyte PyTorch footprint for GPU users and complicates CPU/GPU upgrades. It remains a fallback if the native pack cannot pass legal review or real NVIDIA inference. CPU-only releases omit the user's requested optional NVIDIA path. Depending on a machine-wide CUDA Toolkit creates unreliable prerequisites. Shipping Torch in every base install conflicts with the measured default-size goal.

## Historical design sketch and candidate findings

```ts
type GpuPackState =
  | { status: 'missing'; packId: string; downloadBytes: number }
  | { status: 'downloading'; receivedBytes: number; totalBytes: number }
  | { status: 'validating'; packId: string }
  | { status: 'ready'; packId: string; restartRequired: boolean }
  | { status: 'failed'; code: string; retryable: boolean };

interface TrustedPackDescriptor {
  schemaVersion: number;
  packId: string;
  platform: 'win32-x64';
  appBuildRange: string;
  ctranslate2Id: string; // pinned wheel/build identity, not a loose version
  archive: { url: string; bytes: number; sha256: string };
  members: ReadonlyArray<{ name: string; bytes: number; sha256: string;
    source: string; license: string }>;
}

interface GpuPackManager {
  getState(): GpuPackState;
  install(): Promise<GpuPackState>; // idempotent by descriptor/content hash
  resolveForServerStart(buildId: string): Promise<ValidatedGpuRuntime | null>;
}

interface EffectiveWhisperConfig {
  requestedDevice: 'auto' | 'cpu' | 'cuda';
  requestedComputeType: string;
  effectiveDevice: 'cpu' | 'cuda';
  effectiveComputeType: string;
  unavailableReason?: string;
}
```

`ValidatedGpuRuntime` is an internal branded type. It is never serialized over renderer IPC. Main passes its directory to a managed child process through a private environment value. `server/src/main.py` registers it before importing CTranslate2. The health response includes a runtime fingerprint: app build, server build, pack ID, and effective device. `ServerManager` compares the fingerprint before adopting a healthy process; it cannot silently use a stale or unmanaged server after pack activation.

Module boundaries:

| Owner | Responsibility | Failure behavior |
| --- | --- | --- |
| `GpuPackManager` in Electron main | Trusted descriptor, download, exact validation, staging, immutable publication, local pruning policy | Retain CPU and previous pack; give retryable error code |
| `ServerManager` | Pass validated runtime only at managed launch; compare health fingerprint on adoption | Report restart requirement; do not claim GPU ready |
| Python runtime adapter | Register validated DLL directory before imports; probe CTranslate2 and resolve effective settings | Fall back to CPU while retaining requested settings |
| Renderer Settings | Opt-in action, progress, integrity and capability display | Available while server is down; no path/URL access |
| Release verification | Assert CPU closure lacks Torch/CUDA; verify pack hashes, assets, notices, and real inference | Block release candidate |

## Evidence and blast radius

On pinned Windows CPython 3.11, current release site-packages measured **4,941,557,529 bytes**; Torch's directory measured **4,644,232,862 bytes**. A CPU Faster-Whisper closure measured **285,496,116 bytes**. The raw closure difference is **4,656,061,413 bytes (94.2%)**, before packaging filters and compression. The standalone Python runtime was **75,592,946 bytes** in both cases. This is a source of leverage, not a promised installer saving. The previous HTML's size estimates are unverified; the actual archive, installed directory, and clean test model cache must be measured separately.

The key migration risk is confirmed with real code: when saved settings include `whisper_device=cuda` on a no-CUDA machine, `Settings` validation rejects the object and `get_settings()` returns all defaults. A probe using `cuda`, `DEBUG`, and beam size `7` loaded as `auto`, `INFO`, and `1` in memory, while the saved file remained unchanged. Separate structural parsing from runtime resolution and test a CPU upgrade using saved GPU preferences and unrelated non-default values.

A second CPU-closure probe removed Torch while keeping pinned CTranslate2 4.6.3. `get_cuda_device_count()` returned `1`, yet Eve's `detect_gpu_capabilities('auto')` reported unavailable because PyTorch was absent. The engine imported successfully. This confirms that diagnostics can disagree with the inference library until Torch-based probing is replaced. It does not prove that GPU transcription works without a separately validated DLL pack.

Other release-impacting seams are real:

- Python imports Torch before Faster-Whisper and uses it for diagnostics, VRAM, and cache cleanup. Removing its dependency without replacing those calls breaks startup or device behavior.
- Electron and Python both register `torch/lib`; both paths must be replaced by a single validated-pack contract.
- A healthy existing server can be adopted without comparing runtime identity. Pack activation therefore needs a health fingerprint and restart/adoption rule.
- The release verifier asserts Torch today; the CPU artifact must instead assert its absence and import/transcribe with CTranslate2.
- The exact release asset allowlist and current per-asset ceiling require explicit review for a new GPU asset. The pack's compressed bytes and redistribution rights are unknown.
- The existing installer smoke test uninstalls the prior Eve/Murmur installation first. It cannot prove in-place settings and pack upgrades or rollback. A dedicated upgrade matrix is required.
- The installer currently retains app data on uninstall. A large pack outside the install directory needs an explicit removal and retention policy; do not infer that uninstall cleans it up.
- GPU repair controls must be in Electron Settings IPC so they remain accessible when the server cannot start.

## Required proof before release

1. Identify and license-review the exact NVIDIA redistributable files for pinned CTranslate2; inspect native dependencies and perform short and long real GPU transcription on a clean Windows NVIDIA host with no system CUDA Toolkit. If this fails, do not implement or publish a guessed pack.
2. Build the CPU closure and measure its compressed `nsis-web` archive and clean installed directory. Assert no Torch package or CUDA DLL is shipped. Run Quick and Long CPU dictation, health, diagnostics, and saved-settings upgrade on a machine without an NVIDIA driver.
3. Reject truncated archives, bad hashes, extra or traversal members, wrong architecture, mismatched versions, and interrupted downloads before DLL load. Verify atomic publication, repeated install, startup after reboot, stale-server adoption, rollback, and uninstall/upgrade behavior.
4. Update exact release asset manifest, workflow allowlist, notices, and verifier. Report package, installed, and separate clean-model bytes and compare them with the existing release candidate before promotion.

The existing release-control fixture passed (`uv run --no-sync pytest tests/test_gate6c_release_controls.py -q`: 10 passed). It proves the current exact-asset and hash gate, not GPU pack behavior. The proposed pack trust, real GPU inference, installer size, and upgrade safety remain unproven.

The smallest safe first implementation slice is the settings/runtime separation and CPU closure migration, after the pack feasibility proof. No packaging or runtime release change should be represented as complete until the gates above pass.
