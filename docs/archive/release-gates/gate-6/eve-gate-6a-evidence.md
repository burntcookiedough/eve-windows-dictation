# Eve Gate 6A release-preparation evidence

Status: in progress. This record is factual evidence for Gate 6A only; it is not a
package, lifecycle, merge, tag, release, or publication claim.

## Starting state and authorization

- Repository: `burntcookiedough/eve-windows-dictation`.
- Canonical base: `0d6605d07aa783036d61fc93af7ce043a808f1a6`.
- Gate 6A contract: `e33c9304f6c133867c6a9f0948a943a75fedaca5`.
- Tracking issue: [#21](https://github.com/burntcookiedough/eve-windows-dictation/issues/21),
  `Status: ready`, `Execution Gate: allowed`.
- Parent review verified the contract's clean branch, one-file scope, baseline version
  check, and six-file version-tool dry run before authorizing mechanical Gate 6A work.

## Version preparation

The existing `scripts/version.py` tool was used. Its `0.7.0` dry run named exactly these
six files, and the implementation diff was reviewed before further documentation edits:

1. `app/package.json`
2. `server/pyproject.toml`
3. `server/src/version.py`
4. `server/uv.lock`
5. `README.md`
6. `scripts/release-verify.ps1`

The `server/uv.lock` change is limited to the editable root `murmur` package version.
No dependency version, resolution, or `app/bun.lock` content is part of Gate 6A.

## Factual documentation cleanup

- `ROADMAP.md` now distinguishes prepared Eve v0.7.0 source from the still-public Murmur
  v0.6.3 download and records Gates 1–5 as complete.
- The Gate 5 master ledger records PRs #19 and #20 and their merge commits while retaining
  its historical planning contract and evidence.
- The identity checklist records merged Gates 3–5 and keeps homepage work separate.
- The release notes explicitly state that Eve does not automatically import Murmur data.

## Repository and NOTICE readiness audit

The tracked package metadata points to `burntcookiedough/eve-windows-dictation`. Local
Windows packaging uses `--publish never`. The release workflow runs on `v*` tags and
builds/publishes a release; Gate 6A changes none of this behavior.

Tracked manifests and release configuration prove that a Windows distribution contains an
Electron application, a managed Python runtime, and packaged production Python
dependencies, while models download separately on first use. They do not prove a complete
binary-distribution notice inventory or formal Eve name/mark clearance. Both remain Gate
6C publication blockers.

## Frozen-boundary statement

Gate 6A does not change AppUserModelID, the frozen NSIS GUID, installer chain, profile
roots, startup policy, shared cache behavior, protocols, runtime/engine behavior, updater
behavior, workflows, homepage, dependencies, or internal compatibility names. It does not
inspect or alter personal profiles, installed application state, registry, startup values,
or model-cache contents.

## Validation and hosted review

Completed local checks:

| Check | Result |
|---|---|
| `python scripts/version.py check --tag v0.7.0` | Passed. |
| `uv lock --check --offline` | Passed with a new isolated cache outside the repository; 228 packages resolved without shared-cache access. |
| Server suite | Passed: 139/139 on Python 3.11.15 from the pre-provisioned environment, with Gate 6A `server/src` and test UI source first on `PYTHONPATH`, bytecode disabled, and pytest cache disabled. |
| App suite | Passed: 111/111 tests across 20 files with 640 `expect` assertions, run by the parent in the unrestricted environment against this exact Gate 6A worktree and the hash-matched pre-provisioned dependency tree. |
| History/Insights guard | Passed: `history insights aggregate check passed`. |
| TypeScript | Main and renderer no-emit checks passed. |
| Production build | Main process, both preloads, and Vite renderer passed; the renderer built 140 modules. |
| Tracked diff check | Passed. |
| Final scope/privacy/frozen-boundary audit | Passed: exactly 13 allowlisted files; no generated residue; `app/package.json` and `server/uv.lock` each have only the planned one-line version replacement; AppUserModelID, NSIS GUID, and local `--publish never` packaging command remain exact. |

The fresh clone has no local `app/node_modules` or `server/.venv`. The parent completed
the Bun-blocked checks in an unrestricted environment using the required Bun executable
and a verified temporary junction to the approved dependency tree. That junction and the
generated ignored `app/dist` directory were removed after exact-path verification. No
substitute runtime, dependency installation, sync, download, shared-cache mutation, or
repository artifact was used.

Hosted CI and CodeRabbit review remain pending. This file must be updated only with fresh
hosted-review facts before the Gate 6A PR is marked Ready.
