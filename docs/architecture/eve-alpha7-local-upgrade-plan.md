# Eve v0.8.2-alpha.7 local upgrade plan

**Status:** Candidate plan. This authorizes no public tag, upload, release, or publication.

The alpha.7 branch is a security-first candidate. Complete and review the server and
desktop security changes before packaging or testing an installer on the laptop. Keep
the frozen Eve/Murmur identity, install chain, profiles, protocols, model cache, and
published alpha.6 GPU assets intact.

## Sequence

1. **Finish security first.** Complete the ASGI, WebSocket, configuration, server
   manager, and desktop logging fixes. Run focused checks with synthetic input,
   including proof that enabled debug output omits the synthetic sensitive marker and
   that the processed result and clipboard call are unchanged. Stub clipboard access.
   Resolve actionable high or critical blockers and approved fixes. Document remaining
   lower-risk findings with exploit preconditions and coverage limits for independent
   acceptance. The known same-user Long Dictation memory ceiling remains a coverage
   limit; this alpha does not add an audio-spooling subsystem.
2. **Review and merge the exact PR head.** Include the maintained Electron 44.x update
   and its targeted lock remediation before opening the candidate PR against `trunk`.
   Review the complete diff, exact head, required CI, hosted installer lifecycle gate,
   and independent review findings. Merge only that reviewed head after all required
   checks and independent acceptance pass.
3. **Build a fresh local candidate from the merged head.** Start from a clean checkout
   at the exact merge commit. Use uv 0.12.23 from an isolated tool location under
   `E:\Temp`; do not change globally installed uv or Python. This uv version's
   published download metadata maps the maintained CPython security patch 3.11.17 on
   Windows x64 to the `python-build-standalone` 20261003 `install_only_stripped` build.
   First verify `uv lock --check --offline`, then prepare the frozen Windows CPU
   release closure with `uv sync --python 3.11.17 --no-dev --extra release --frozen`.
   Run `uv run --no-project --python 3.11.17 python scripts/version.py check --tag
   v0.8.2-alpha.7` and prepare the relocatable runtime with
   `./scripts/prepare-python-runtime.ps1 -PythonVersion 3.11.17`. This keeps the
   existing CPython 3.11 ABI. Build the Windows `nsis-web` installer with
   `bun run package:win` (`--publish never`). Record the exact commit, installer and
   payload names, sizes, and hashes.
   Do not reuse an earlier package or package cache.
4. **Verify the packaged renderer.** Exercise the renderer from the generated package
   with its packaged Electron runtime; a development server or unpackaged UI build does
   not satisfy this check. Confirm the packaged UI loads before the laptop test.
5. **Test the installer in place on the laptop.** Use the fresh alpha.7 `nsis-web`
   installer over the existing installation. Before and after installation, confirm
   the expected Eve and preserved Murmur profile roots remain present using aggregate
   metadata only. Keep profile contents opaque: do not read, copy, enumerate, or alter
   personal settings, history, audio, transcripts, clipboard data, or model-cache
   contents. Do not uninstall first or wipe caches. Stop on any identity, installer,
   launch, health, or profile-preservation failure; preserve the installation and
   collect only privacy-safe evidence.

## Compatibility and publication boundary

The dedicated hosted lifecycle check is a required PR check and runs only on a
disposable GitHub-hosted Windows runner. It verifies the pinned published alpha.5
baseline, upgrades it in place to alpha.7, checks synthetic profile and model-cache
sentinels, runs CPU transcription, exercises rollback to alpha.5, and uninstalls. Keep
all alpha.5 asset IDs, sizes, hashes, tag, and manifest pins fixed.

The app identity continues to come from the package version, so the GPU manager's
`appBuildId` must match `0.8.2-alpha.7`. Reuse the already published alpha.6 GPU pack
by keeping its exact URLs, compressed and unpacked sizes and hashes, and CTranslate2
build ID. Prove the production descriptor is available to the alpha.7 identity and is
rejected for a mismatched identity before any asset request.

This work ends after local in-place upgrade evidence is reviewed. Do not create or move
a public tag, upload assets, create a release, or publish the candidate. The published
v0.8.2-alpha.5 Eve release is this candidate's fixed lifecycle baseline; this plan
makes no claim about the latest public release at a later date.
