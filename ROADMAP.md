# Roadmap

This roadmap separates shipped behavior from design and research. It is not a release-date promise.

## Current baseline

v0.6.3 is the production baseline. It retains the Murmur application identity and ships a packaged Python runtime with faster-whisper/CTranslate2 and NeMo/PyTorch/CUDA dependency stacks. Models download separately on first use.

The repository is now standalone under `burntcookiedough/eve-windows-dictation`, and its release configuration targets that repository. Existing app IDs, installer identity, update behavior, and user-data paths remain unchanged.

## Next: application-identity migration design

The proposed technical contract is documented in [ADR-001](docs/architecture/adr-001-eve-application-identity-migration.md). Trademark work is currently deferred; it remains separate from the compatibility design.

Before an Eve-branded binary is produced:

- complete manual trademark checks in relevant software classes and markets;
- inventory every app ID, executable, installer, protocol, package, update, and data-path identifier;
- establish a fresh Eve profile that never imports Murmur History, settings, hotwords, browser storage, credentials, or external-server configuration;
- preserve the inactive Murmur data directory without reading, moving, or deleting personal files; permit only a bounded `server.pid` ownership check when required to prevent process conflicts;
- test clean install, upgrade, downgrade/rollback, repair, startup registration, and uninstall without deleting either data profile or shared model caches;
- complete the binary-distribution third-party notice audit.

## Later: visual system

Design Eve's icon, typography, color, windows, overlay, onboarding, and public screenshots after identity and migration constraints are fixed. Do not reskin the existing product and treat that as an identity migration.

## Later: component-based distribution

The measured installer payload is dominated by portable Python and two independent ASR runtime stacks. The planned direction is a thin core client with separately versioned engine packs, while model weights remain separate first-use downloads.

Required properties include resumable downloads, signed or checksum-verified manifests, exact size and disk preflight, atomic staging and activation, compatibility metadata, rollback, repair, offline behavior, and uninstall rules that preserve user data and model caches.

## Later: profile-based ASR experiments

- Fast Dictation: evaluate Nemotron 3.5 ASR Streaming 0.6B through an isolated Transformers/PyTorch pack on native Windows.
- Long Dictation: evaluate Qwen3-ASR 0.6B through Transformers with deterministic offline decoding.
- Hinglish: evaluate the Srota Qwen3-ASR fine-tune as an experimental opt-in.
- Production fallback: retain faster-whisper until challengers pass accuracy, latency, memory, packaging, recovery, and component lifecycle gates on target Windows hardware.

Do not ship vLLM inside the native Windows client. Benchmark raw ASR output separately from optional cleanup, and preserve model downloads as a different lifecycle from runtime/engine packs.
