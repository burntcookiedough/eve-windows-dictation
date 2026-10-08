# Eve documentation

Eve is a local Windows push-to-talk dictation assistant built with Electron and Faster-Whisper. The current published release is `v0.8.2-alpha.8`.

## Start here

- [Windows development and building](development/building.md): Build, package, and verify the app on Windows.
- [Project roadmap](project/roadmap.md): Current baseline (alpha.8), shipped CPU default, optional GPU pack, and milestones.
- [Speech-model selection](speech-model-selection.md): Curated Faster-Whisper model choices and download behavior.
- [Installer dependencies](installer-dependencies.md): Standalone Python runtime, CTranslate2, and optional NVIDIA pack dependencies.
- [Protocol](protocol.md): Local WebSocket client-server transcription protocol.

## Architecture and runtime

- [Application identity ADR (ADR-001)](architecture/adr-001-eve-application-identity-migration.md): Fresh-profile separation and Murmur compatibility architecture.
- [Lean runtime architecture](architecture/eve-lean-runtime-architecture.md): CPU base distribution and modular GPU acceleration model.
- [Lean runtime release plan](architecture/eve-lean-runtime-release-plan.md): Packaging controls, size accounting, and verification gates.
- [GPU pack provenance](architecture/eve-gpu-pack-provenance.md): Provenance and SHA-256 verification of optional NVIDIA runtime DLLs.
- [GPU pack lifecycle](architecture/eve-gpu-pack-lifecycle.md): Resume, ownership, disk-space, Repair/Remove, and retention policy.
- [CPU first-run decision](architecture/eve-cpu-first-run-decision.md): Architectural decision for CPU-first dictation on Windows.
- [CPU dictation benchmark](architecture/eve-cpu-dictation-benchmark.md): Historical measurements supporting the first-run decision.

## Development and releases

- [Agent workflow](development/agent-workflow.md): Branching, testing, and verification procedures for contributors and agents.
- [GPU lifecycle validation](development/gpu-pack-lifecycle-validation.md): Repeatable Windows source checks and exact-candidate acceptance exercises.
- [v0.8.2-alpha.8 release notes](releases/eve-v0.8.2-alpha.8-release-notes.md): Current published alpha release notes.

## History and archive

- [Archive index](archive/README.md): Retained release gates (Gates 1–6), candidate records, and case studies.
- [Historical machine setup](windows-local-cuda-dictation.md): Machine-specific Murmur v0.6.3 CUDA verification setup.
- [Retired feature checklist](development/feature-status.md): Historical 2026-02-02 snapshot, outside the current backlog.
