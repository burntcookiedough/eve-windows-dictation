# Eve v0.8.2-alpha.4 release preparation

Status: authorized release candidate. The user authorized integration, exact-head
packaging, lifecycle validation, and publication on 2026-09-18. Every later action remains
conditional on the preceding gate passing; a failed gate stops publication.

## Scope

Eve v0.8.2-alpha.4 removes the retired Nemotron runtime and narrows the shipped product to
one model family: Faster-Whisper through its dedicated adapter. It removes unsupported
dependencies, source paths, proof-of-concept assets, settings, and UI branches while
preserving bounded migration of existing settings. The model runtime and catalog remain
explicit seams so a future family can arrive through a separately reviewed adapter and
dependency closure. The bundled runtime remains distinct from separately downloaded model
weights.

## Frozen boundaries

The preparation retains AppUserModelID `io.github.burntcookiedough.eve`, NSIS GUID
`0204d005-75b3-5b31-b1f6-ef2831e2b204`, Eve visible identity, `nsis-web`, the active
`%APPDATA%\Eve` profile, preserved `%APPDATA%\murmur` profile, shared model-cache
behavior, and internal Murmur runtime/protocol/environment/install-chain names. It does
not inspect personal content or cache contents, and it does not add signing, an updater,
thin-client/engine packs, a single-file installer, or cache migration/deletion.

## Merge and publication gates

1. The complete candidate must be reviewed and merged through a PR targeting `trunk`.
   Incremental stack PRs are review aids and are never merged as release integration.
2. Freeze the exact resulting `trunk` commit and build one fresh `nsis-web` package from
   it in a clean alpha.4 output directory.
3. Run `scripts/installer-smoke.ps1` for the install/uninstall lifecycle and
   `scripts/release-verify.ps1` for the installed package and Faster-Whisper runtime;
   stop on any failure.
4. Generate the exact seven-asset manifest/checksum set, independently reverify it, and
   create the annotated tag and matching draft without moving or replacing either later.
5. Dispatch the protected verification/promotion workflow from `trunk` with prerelease,
   unsigned-build, and accepted-name-risk inputs matching the recorded release policy.
6. Download the public assets and compare their hashes with the accepted manifest.

Historical release assets and hashes are immutable. Packaging or publication must not
reuse alpha.3 output directories, artifacts, tags, draft releases, or manifests.
