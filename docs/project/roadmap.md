# Roadmap

This roadmap separates shipped behavior from research. It is not a release-date promise.

## Current baseline

Eve v0.8.2-alpha.8 is published on [GitHub Releases](https://github.com/burntcookiedough/eve-windows-dictation/releases).

It supports Faster-Whisper through CTranslate2 with a self-contained CPU runtime,
an opt-in NVIDIA runtime pack, and separately downloaded model weights. Long Dictation
uses a 4 MiB in-memory PCM spool threshold and temporary storage for larger sessions.
See the [alpha.8 release notes](../releases/eve-v0.8.2-alpha.8-release-notes.md),
[model reference](../speech-model-selection.md), and [installer dependencies](../installer-dependencies.md).

The frozen installer chain, internal Murmur compatibility interfaces, and historical
Murmur v0.6.3 assets remain unchanged. Eve uses `%APPDATA%\Eve` and does not
automatically import or delete the legacy `%APPDATA%\murmur` profile or its personal data.
The identity and privacy boundaries remain governed by [ADR-001](../architecture/adr-001-eve-application-identity-migration.md).

## Completed milestones

- Gates 1–4 established compatibility, profile separation, visible Eve identity, and AppUserModelID.
- Gates 5A and 5B established the renderer/accessibility system and cactus resources.
- Gate 6 completed the public v0.7.0 lifecycle.
- Alpha.4 narrowed the runtime to Faster-Whisper; alpha.5 added History export.
- Alpha.6 introduced the lean CPU package and optional NVIDIA pack; alpha.7 hardened security.
- Alpha.8 bounded Long Dictation PCM retention. PR #97 completed cosmetic fixture cleanup.

Issue #57 is closed as completed. Its old backlog and the retired feature checklist
are historical records, not pending implementation instructions. Trademark work remains separate.

## Future work and release controls

Additional model families require a separately reviewed adapter and dependency closure,
plus accuracy, latency, memory, packaging, and recovery evidence. Earlier component-distribution
and model research is retained in the [historical roadmap](../archive/project/roadmap.md);
it does not describe a shipped feature or authorize implementation.

The [lean-runtime release controls](../architecture/eve-lean-runtime-release-plan.md)
remain applicable. Runtime, signing, packaging, and publication each require their own
approved scope. Start from the [documentation index](../README.md) for current guidance
and the [archive index](../archive/README.md) for prior plans and evidence.
