# Eve v0.8.0 release preparation

Status: preparation in progress. This record covers source metadata, release notes, and
validation only; it does not authorize packaging, tagging, draft-release creation, asset
upload, or publication.

## Scope

Eve v0.8.0 combines the accepted v0.8 UX/model-management work: accessible transcript
follow-scroll, read-only Home readiness, renderer-owned shared server/model status,
explicit curated model preparation, and safe selected-model download preflight. The
bundled runtime remains distinct from separately downloaded model weights.

## Frozen boundaries

The preparation retains AppUserModelID `io.github.burntcookiedough.eve`, NSIS GUID
`0204d005-75b3-5b31-b1f6-ef2831e2b204`, Eve visible identity, `nsis-web`, the active
`%APPDATA%\Eve` profile, preserved `%APPDATA%\murmur` profile, shared model-cache
behavior, and internal Murmur runtime/protocol/environment/install-chain names. It does
not inspect personal content or cache contents, and it does not add signing, an updater,
thin-client/engine packs, a single-file installer, or cache migration/deletion.

## Required later gates

Before any public v0.8.0 release, a separately authorized exact-head Windows package and
lifecycle validation must pass. Publication remains a separate consequential decision;
historical v0.7.0 release assets and hashes are immutable.
