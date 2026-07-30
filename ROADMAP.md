# Roadmap

This roadmap separates shipped behavior from design and research. It is not a release-date promise.

## Current baseline

Eve v0.7.0 is public. The latest public download is Eve v0.7.0; historical Murmur
v0.6.3 assets remain immutable. The Eve source
retains the frozen Murmur installer chain while using the Eve product identity, an
isolated Eve profile, the approved visual/accessibility system, and packaged cactus
resources. Its portable Python runtime and separately downloaded models remain subject to
their existing release gates.

The repository is standalone under `burntcookiedough/eve-windows-dictation`, and its
release configuration targets that repository. The approved cutovers use the Eve
product identity, AppUserModelID `io.github.burntcookiedough.eve`, and isolated
`%APPDATA%\Eve` profile. The frozen Murmur installer chain and GUID, update
compatibility, and internal compatibility interfaces remain unchanged.

## Completed: application identity and visual system

The technical contract is documented in [ADR-001](docs/architecture/adr-001-eve-application-identity-migration.md).
Gates 1–4 completed the compatibility, fresh-profile, visible-identity, and
AppUserModelID cutover. Gates 5A and 5B completed the approved renderer/accessibility
system and cactus Windows resources. Trademark work remains separate and incomplete.

The v0.7.0 publication gates were completed under the separate Gate 6 record. Future
work continues to preserve the established identity, profile, installer, and privacy boundaries.

The completed gates established a fresh Eve profile that does not automatically import
Murmur History, settings, hotwords, browser storage, credentials, or external-server
configuration. They also proved the compatibility lifecycle for the accepted candidates;
the public release still requires fresh Gate 6 evidence.

## Next: model-management clarity

v0.8 work clarifies curated model choices and explicit first-use preparation while keeping
the bundled runtime separate from downloaded model weights. It does not add engine packs,
an updater, cache management, signing, or thin-client distribution.

## Later: component-based distribution

The measured installer payload is dominated by portable Python and two independent ASR runtime stacks. The planned direction is a thin core client with separately versioned engine packs, while model weights remain separate first-use downloads.

Required properties include resumable downloads, signed or checksum-verified manifests, exact size and disk preflight, atomic staging and activation, compatibility metadata, rollback, repair, offline behavior, and uninstall rules that preserve user data and model caches.

## Later: profile-based ASR experiments

- Fast Dictation: evaluate Nemotron 3.5 ASR Streaming 0.6B through an isolated Transformers/PyTorch pack on native Windows.
- Long Dictation: evaluate Qwen3-ASR 0.6B through Transformers with deterministic offline decoding.
- Hinglish: evaluate the Srota Qwen3-ASR fine-tune as an experimental opt-in.
- Production fallback: retain faster-whisper until challengers pass accuracy, latency, memory, packaging, recovery, and component lifecycle gates on target Windows hardware.

Do not ship vLLM inside the native Windows client. Benchmark raw ASR output separately from optional cleanup, and preserve model downloads as a different lifecycle from runtime/engine packs.
