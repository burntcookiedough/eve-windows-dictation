# Eve Gate 6 release plan

- Status: Gate 6A contract parent-reviewed and passed; mechanical implementation in progress
- Repository: `burntcookiedough/eve-windows-dictation`
- Canonical base: `0d6605d07aa783036d61fc93af7ce043a808f1a6`
- Tracking issue: [#21](https://github.com/burntcookiedough/eve-windows-dictation/issues/21)
- Proposed release: Eve `v0.7.0`
- Last updated: 2026-07-28 (Asia/Calcutta)

## Purpose and outcome

Gate 6 prepares and, through separately approved stages, publishes the first Eve-branded
Windows release after the compatibility, identity, privacy, visual, accessibility, and
resource work completed in Gates 1–5.

The intended outcome is a release whose source version, release notes, package identity,
artifact set, Windows lifecycle evidence, and public GitHub record all describe the same
accepted code. Release preparation must not weaken the established compatibility or
privacy boundaries merely to make publication easier.

Gate 6 is deliberately split:

- **Gate 6A — release preparation:** documentation, factual status cleanup, synchronized
  version metadata, release notes, release-readiness audits, tests, CI, CodeRabbit, and a
  Ready-but-unmerged pull request.
- **Gate 6B — exact release candidate:** one fresh package from the final accepted release
  head and the complete privacy-safe Windows lifecycle. It requires separate explicit
  authorization.
- **Gate 6C — publication:** final merge/tag/release procedure and public-download
  validation. It requires separate explicit authorization after Gate 6B passes and all
  publication blockers are resolved.

Authorization for one stage never implies authorization for a later stage.

## Release-version decision

The proposed version is `0.7.0`.

- `0.6.4` would understate the coordinated, backward-compatible product milestone:
  Gates 1–5 established a separate Eve profile, visible Eve identity, the approved
  AppUserModelID, a new application shell and accessibility system, and original packaged
  cactus resources.
- `1.0.0` would overstate current release maturity. Signing, the large installer/runtime
  distribution strategy, formal name/mark clearance, and other pre-1.0 work remain open.
- `0.7.0` communicates a substantial but still pre-1.0, backward-compatible milestone.

The version decision changes no protocol, data format, runtime, engine, dependency, or
installer identity.

## Decision ledger

| Decision | Status | Evidence or consequence |
|---|---|---|
| Prepare Eve `v0.7.0` | Approved for Gate 6A | User-authorized release-preparation decision; no publication implied. |
| Keep Gates 6A, 6B, and 6C separate | Frozen | Packaging/lifecycle and publication remain consequential independent gates. |
| Preserve the Gates 1–5 compatibility and privacy architecture | Frozen | No release convenience may alter identity, profiles, startup, cache, runtime, or protocol behavior. |
| Use the existing version tool for all synchronized metadata | Approved | `scripts/version.py bump 0.7.0` owns exactly six files. |
| Add human-reviewed release notes | Approved | The repository has no tracked changelog/release-note convention; the tag workflow currently generates notes automatically. |
| Do not claim automatic Murmur History import | Frozen | Eve ships a fresh profile. A one-time user-requested local migration was not product behavior. |
| Do not package in Gate 6A | Frozen | Gate 6B owns the single final exact-head candidate package. |
| Do not tag while the current publication procedure is unresolved | Frozen | A `v*` tag immediately invokes a workflow that builds and publishes. |
| Treat unresolved notice or name/mark risk as a Gate 6C blocker | Frozen | Record limitations; do not invent legal conclusions or speculative code changes. |

## Canonical program state

Canonical `trunk` at the start of Gate 6 is merge commit
`0d6605d07aa783036d61fc93af7ce043a808f1a6`, which merged Gate 5B PR #20. Gates 1–5
are complete:

| Gate | Accepted result |
|---|---|
| Gate 1 / PR #15 | Frozen NSIS installer continuity and compatibility scaffolding. |
| Gate 2 / PR #16 | Isolated `%APPDATA%\Eve` profile with no automatic legacy-profile access. |
| Gate 3 / PR #17 | Visible Eve product, executable, installer, and shortcut identity. |
| Gate 4 / PR #18 | AppUserModelID `io.github.burntcookiedough.eve` with frozen NSIS GUID. |
| Gate 5A / PR #19 | Approved monochrome renderer, overlay, IA, and accessibility system. |
| Gate 5B / PR #20 | Original cactus resources, deterministic derivatives, and passed Windows lifecycle. |

Gate 5 evidence remains durable historical evidence. Gate 6A may correct stale status
ledgers but must not rewrite Gate 1–5 acceptance results.

## Frozen boundaries

All Gate 6 stages preserve these values and behaviors unless a future, separately
approved architecture decision explicitly changes them:

- AppUserModelID and Electron Builder app ID:
  `io.github.burntcookiedough.eve`;
- NSIS GUID: `0204d005-75b3-5b31-b1f6-ef2831e2b204`;
- the published Murmur install/upgrade/uninstall chain and the retained internal install
  path needed for that chain;
- product name `Eve`, executable `Eve.exe`, and existing artifact compatibility names;
- `%APPDATA%\Eve` as Eve's profile and `%APPDATA%\murmur` as a preserved legacy profile;
- no automatic import, merge, fallback, prompt, or deletion involving the Murmur profile;
- exact startup/login policy and allowlisted legacy-entry handling;
- shared Hugging Face/model-cache behavior and locations;
- IPC, WebSocket protocol, `window.murmurMain`, `window.murmur`, `MURMUR_*`, Python
  package/CLI names, and other internal compatibility surfaces;
- packaged Python, Faster-Whisper, NeMo, PyTorch, CUDA, CTranslate2, ONNX Runtime, model
  selection, and engine behavior;
- repository/publish target `burntcookiedough/eve-windows-dictation`;
- updater and release behavior unless a later stage explicitly authorizes a focused
  publication-procedure change; and
- current homepage, signing, and release infrastructure outside this plan's approved
  stage.

No Gate 6 work may inspect personal transcript text, audio, settings, hotwords,
credentials, browser data, clipboard data, logs, or unknown startup values. It may not
move, delete, enumerate internally, or alter either profile, installed application,
registry/login state, shared model cache, or the preserved migration backup.

The user-requested one-time local import of 541 Murmur transcription records is machine
maintenance history only. It is not shipped automatic migration behavior and must never
appear as such in release notes, support copy, or acceptance claims.

## Gate 6A — release preparation

### Authorized scope

1. Preserve this permanent Gate 6 contract.
2. Correct only present-tense stale status in `ROADMAP.md`, the Gate 5 master ledger, and
   the Eve identity checklist.
3. Run the existing version tool to set its six owned files to `0.7.0`.
4. Add concise human-reviewed `v0.7.0` release notes based on merged Gates 1–5.
5. Audit repository/publish/updater configuration without changing behavior.
6. Audit third-party binary-distribution NOTICE readiness and record facts, limitations,
   and blockers.
7. Record preliminary Eve name/mark readiness without claiming formal legal clearance.
8. Run focused checks, full Gate A, exact scope/privacy/frozen-boundary audit, hosted CI,
   and a real CodeRabbit review.
9. Leave the Gate 6A PR Ready but unmerged.

### Non-goals and prohibited actions

Gate 6A must not:

- change production application or server behavior;
- change dependencies, dependency constraints, dependency resolution, or lockfile
  content other than the single root-package version field owned by
  `scripts/version.py`;
- change workflows, runtime, engines, models, protocols, IPC, profiles, startup/login,
  cache, updater behavior, homepage, signing, AppUserModelID, NSIS GUID, install chain,
  or internal compatibility names;
- build a Windows package, create installer artifacts, install, repair, uninstall,
  rollback, launch a lifecycle candidate, or mutate application/registry/profile state;
- merge a PR, create or push a tag, create a GitHub release or draft, upload an asset, or
  publish anything;
- rewrite historical Gate 1–5 evidence;
- claim formal trademark clearance or a completed NOTICE inventory without evidence; or
- claim automatic Murmur History migration.

### Exact Gate 6A allowlist and ceiling

Gate 6A may change at most these **13 tracked files**. This is an allowlist, not a
requirement to modify every file. A fourteenth file requires explicit scope review
before it is changed.

| # | File | Why it is allowed |
|---:|---|---|
| 1 | `docs/architecture/eve-gate-6-release-plan.md` | Permanent 6A/6B/6C contract, audit findings, approvals, and continuation instructions. |
| 2 | `docs/architecture/eve-gate-6a-evidence.md` | Exact-head local/hosted validation, audit limitations, review disposition, and Ready handoff. |
| 3 | `docs/releases/eve-v0.7.0-release-notes.md` | Concise human-reviewed release notes; no automatic-import claim. |
| 4 | `ROADMAP.md` | Factual current-baseline and completed identity/visual-stage correction only. |
| 5 | `docs/architecture/eve-gate-5-master-plan.md` | Factual Gate 5A/5B final ledger correction only; historical body remains intact. |
| 6 | `docs/architecture/eve-identity-cutover-checklist.md` | Factual merged Gate 3/4/5 and remaining-release status correction only. |
| 7 | `NOTICE.md` | User-facing third-party notice-readiness facts and unresolved limitations only. |
| 8 | `app/package.json` | Version field only, through the existing version tool. |
| 9 | `server/pyproject.toml` | Root project version field only, through the existing version tool. |
| 10 | `server/src/version.py` | Server version constant only, through the existing version tool. |
| 11 | `server/uv.lock` | Editable root `murmur` package version only, through the existing version tool. |
| 12 | `README.md` | Version badge/alt text only, through the existing version tool; published v0.6.3 download table remains historical until Gate 6C. |
| 13 | `scripts/release-verify.ps1` | Default expected version only, through the existing version tool. |

`scripts/version.py` is authoritative but is not itself modified. `app/bun.lock` is not
version-owned by the script and must remain byte-identical. No workflow or release
configuration file is allowed.

### Implementation sequence

1. Verify issue #21 remains open with `Status: ready` and `Execution Gate: allowed`.
2. Verify branch ancestry, exact base, and clean worktree.
3. Run `python scripts/version.py check` and
   `python scripts/version.py bump 0.7.0 --dry-run`.
4. Make the three factual status corrections without altering historical evidence.
5. Run `python scripts/version.py bump 0.7.0`; inspect every changed hunk and prove the
   root `server/uv.lock` version is the only lockfile change.
6. Add concise release notes and the factual Gate 6A evidence record.
7. Complete repository/updater, NOTICE, and preliminary name/mark audits; record
   unresolved blockers rather than guessing.
8. Run focused version/release assertions and full Gate A.
9. Audit the full diff against this 13-file allowlist and every frozen boundary.
10. Commit minimal changes, push the branch, and open a draft PR linked to issue #21.
11. Wait for hosted CI at completion boundaries.
12. Mark Ready only after local and hosted acceptance, then obtain a real CodeRabbit
    review.
13. Disposition every thread, revalidate justified fixes, and leave the PR Ready but
    unmerged.

### Release-note content contract

The `v0.7.0` notes may describe:

- the visible Eve identity and approved AppUserModelID;
- the separate fresh Eve profile and preservation of the Murmur profile;
- History, Insights, Settings, Advanced Server placement, and the accepted monochrome
  accessibility system;
- the noninteractive waveform/transcript overlay behavior;
- the original cactus application and Windows resource family;
- existing local Faster-Whisper/Nemotron, CUDA, diagnostics, singleton, and installer
  continuity where supported by merged evidence; and
- the unsigned-release warning and known large download/model-download behavior.

They must state that Eve does not automatically import Murmur personal data. They must
not convert the user's one-time local import into a feature claim, invent settings or
analytics, promise signing, call the product 1.0-ready, or claim publication before it
occurs.

### Repository, updater, and publication audit

The planning audit found:

- `app/package.json` points both repository and Electron Builder GitHub publishing to
  `burntcookiedough/eve-windows-dictation`;
- the local Windows packaging command includes `--publish never`;
- no `electron-updater` or in-app auto-updater implementation is present in the
  production source found by the audit;
- the NSIS-web distribution uses GitHub release metadata and `latest.yml` for payload
  discovery;
- `.github/workflows/release.yml` runs on every `v*` tag, builds a fresh Windows package,
  and publishes a GitHub release with generated notes and matching artifacts; and
- the latest public download remains the historical Murmur `v0.6.3` release.

Therefore Gate 6A changes no updater or workflow behavior. Before Gate 6C, the user must
approve a publication procedure that reconciles Gate 6B's verified candidate with the
tag-triggered workflow. Pushing a `v0.7.0` tag without that decision would immediately
build and publish and is prohibited.

### NOTICE and name/mark audit

`NOTICE.md` currently preserves the original Murmur MIT attribution and explicitly says
that the binary-distribution third-party notice audit is unfinished. The packaged
closure includes a managed Python distribution, Electron/Node dependencies, Python
dependencies, ASR/runtime libraries, CUDA-adjacent binaries, and separately downloaded
models with their own terms.

Gate 6A must inventory the distributed closure using manifests, lockfiles, package
metadata, embedded license/notice files, and authoritative upstream terms. The audit
must distinguish:

- code and binaries actually shipped in the installer;
- build-only and test-only tools not shipped;
- models downloaded separately on first use; and
- platform/vendor components whose redistribution terms need separate confirmation.

`NOTICE.md` may be updated only with verified attribution and limitations. If a complete
binary-distribution notice set cannot be proven, Gate 6A may still reach Ready with the
limitation recorded, but Gate 6C remains blocked.

The cactus provenance record is an originality record, not a trademark opinion.
Repository documents defer formal review of the word mark **Eve**. Gate 6A may record a
preliminary conflict/search log, but no agent may claim legal clearance. Any unresolved
name/mark risk blocks Gate 6C until the user explicitly accepts a documented risk or
obtains appropriate review.

### Gate 6A acceptance matrix

| Requirement | Evidence |
|---|---|
| Exact base and ancestry | `git rev-parse HEAD`, `git rev-parse origin/trunk`, merge-base, remote URL, clean status. |
| Version synchronization | Dry-run list, `bump 0.7.0`, `check --tag v0.7.0`, exact six-file version diff. |
| Factual status cleanup | Line-by-line diff proving only current status changed in the three allowed historical documents. |
| Release notes | Manual claim-to-merged-evidence review; explicit no-automatic-import statement. |
| Repository/updater readiness | Static audit of package metadata, release workflow, tests, and absence/presence of updater implementation. |
| NOTICE readiness | Dependency/distribution inventory with sources, verified notices, limitations, and Gate 6C blocker decision. |
| Frozen identities | Exact assertions for app ID, AppUserModelID, GUID, product/executable names, profile roots, startup constants, publish target, and package command. |
| Dependency integrity | Manifests and lockfiles unchanged except allowed version-owned fields; frozen install commands. |
| Privacy | No access to user profiles/application/registry/cache; no sensitive/generated artifact in the diff or untracked tree. |
| Full Gate A | Version check, app tests, History/Insights check, TypeScript, production build, server tests, lock check, diff check, scope/privacy audit. |
| Hosted acceptance | Draft PR CI, Ready transition, real CodeRabbit review, all threads dispositioned, clean final head. |
| Handoff | PR open, Ready, mergeable, unmerged; exact head/scope/worktree recorded. |

### Gate 6A validation commands

All runtime, dependency, test, and build commands execute in Windows PowerShell, as
required by `AGENT.md`. Gate 6A does not install or update dependencies.

```powershell
# Repository and issue gate
git remote get-url origin
git rev-parse HEAD
git rev-parse origin/trunk
git merge-base HEAD origin/trunk
git status --short --branch

# Version-owned metadata
python scripts/version.py check
python scripts/version.py bump 0.7.0 --dry-run
python scripts/version.py bump 0.7.0
python scripts/version.py check --tag v0.7.0

# Application (existing dependencies only)
Set-Location app
bun test
bun run test:history
bunx tsc -p tsconfig.main.json --noEmit
bunx tsc -p tsconfig.json --noEmit
bun run build

# Server (existing Windows environment only; no sync/install)
Set-Location ..\server
uv lock --check
uv run --no-sync pytest

# Final repository audit
Set-Location ..
git diff --check origin/trunk...HEAD
git diff --name-only origin/trunk...HEAD
git status --short --branch
```

If the fresh clone lacks already-valid Windows dependencies, Gate 6A must not install or
mutate them silently. Use hosted CI for the authoritative dependency-materialized run or
request explicit authorization for a bounded environment-preparation step.

### Gate 6A stop conditions

Stop immediately if:

- the canonical base or issue gate differs;
- a fourteenth tracked file is required;
- version tooling changes anything beyond its six declared fields;
- a dependency, workflow, production behavior, identity, installer, profile, startup,
  cache, protocol, runtime, updater, homepage, or release setting drifts;
- personal or installed-machine state would need inspection or mutation;
- release notes require an unsupported claim;
- NOTICE or name/mark evidence is represented as stronger than it is;
- validation reveals a production regression;
- a package, install, tag, release, or publication action would be needed; or
- CI/review cannot be reconciled within two focused correction rounds.

### Gate 6A rollback

Before a PR exists, rollback is removal of the disposable Gate 6A branch/clone after
preserving this contract commit for review. After a PR exists, use additive corrective
commits or close the unmerged PR. Never rewrite shared history or reset user work.

Gate 6A changes repository files only. It has no application/profile/registry rollback
because those systems must remain untouched.

## Gate 6B — exact release candidate

### Authorization boundary

Gate 6B is not authorized by Gate 6A. It begins only after the user reviews the complete
Gate 6A PR/head and explicitly authorizes the exact package/lifecycle plan.

### Required inputs

- the final accepted Gate 6A release head and tree;
- clean exact-head package workspace with the full locked Windows runtime;
- resolved Gate 6A scope and validation findings;
- explicit user authorization for package and application-state lifecycle changes;
- bounded preflight for disk space, artifact staging, current installation, exact scoped
  startup state, profile aggregate metadata, and shared-cache root presence without
  reading personal contents; and
- checksum-verified official `v0.6.3` rollback artifacts.

Gate 5B candidate packages are acceptance history and must not be reused as `v0.7.0`
release artifacts.

### Package rule

Run exactly one accepted deterministic Windows package from the final frozen Gate 6
release head. If that attempt fails or its identity/runtime closure is ambiguous, stop;
any replacement attempt requires new explicit authorization.

Hash and preserve independent artifact sets when repair consumes a payload. Record exact
bytes and SHA-256/SHA-512 for the wrapper, payload, manifest, blockmaps where present,
unpacked application, and relevant identity resources. No generated artifact belongs in
Git.

### Lifecycle matrix

Gate 6B must prove, at minimum:

1. packaged version, product/file metadata, AppUserModelID, frozen GUID, artifact names,
   repository metadata, and runtime closure;
2. upgrade over the accepted installed Eve/Murmur-chain state;
3. a bounded clean-install scenario without inspecting personal profiles;
4. title-bar/taskbar/tray/Start/shortcut/uninstaller/notification cactus identity;
5. owned PID-file health, singleton behavior, CUDA/runtime availability, and controlled
   Fast and Long Dictation using repository fixtures with no retained transcript/audio;
6. same-version repair using an untouched hash-verified payload;
7. normal uninstall preserving both profiles, scoped login state, unknown entries, and
   shared caches;
8. checksum-verified official `v0.6.3` rollback and fresh owned health; and
9. exact restoration of pre-test scoped startup state.

Only aggregate counts/bytes/timestamps for the two profile roots may be recorded.
Unknown startup values and cache contents remain uninspected.

### Gate 6B output and stop conditions

Gate 6B produces an immutable artifact/evidence handoff outside Git unless a separately
approved evidence-only repository change is proven compatible with the exact-head
release rule. It does not merge, tag, create a release, upload, or publish.

Stop on identity/version/GUID drift, incomplete runtime closure, artifact mismatch,
profile/startup/cache mutation beyond owned behavior, dictation or singleton failure,
repair/uninstall failure, rollback failure, notice/name blocker, or any need to inspect
personal data. Do not guess or automatically retry.

## Gate 6C — merge, tag, and publication

### Authorization boundary

Gate 6C requires a new explicit user authorization after:

- Gate 6A is Ready and accepted;
- Gate 6B passes from the exact accepted release head;
- artifact hashes and lifecycle evidence are independently reviewed;
- NOTICE readiness is complete or explicitly resolved;
- Eve name/mark risk is explicitly resolved or accepted; and
- the publication procedure below is unambiguous.

### Publication-procedure blocker

The current `.github/workflows/release.yml` runs on a `v*` tag and immediately builds
and publishes. This creates a consequential choice:

1. authorize the tag-triggered workflow as the publication build, treating Gate 6B as a
   release-candidate rehearsal and independently comparing the published closure; or
2. separately authorize a focused workflow/manual-upload procedure that publishes the
   exact Gate 6B artifacts without an uncontrolled second build.

Gate 6A does not choose or implement either option. No `v0.7.0` tag may be pushed until
the user approves one exact method and its rollback.

### Gate 6C acceptance

Before publication:

- re-audit PR/head/tree, mergeability, CI, CodeRabbit, allowlist, version, and clean
  worktree;
- merge only the accepted release change using the repository's approved merge method;
- prove canonical `trunk` contains the accepted tree;
- prove tag `v0.7.0` points at the explicitly approved release commit;
- publish only the approved, hash-verified artifact set with human-reviewed notes; and
- ensure the unsigned-release warning remains accurate.

After publication:

- independently verify the GitHub release, tag, asset names, bytes, hashes, manifest,
  repository URLs, and clean public download;
- test the NSIS-web wrapper's public payload resolution;
- verify the public installer against the approved lifecycle identity/runtime closure;
- record any release workflow divergence or artifact mismatch as a release failure; and
- never delete or replace historical `v0.6.3` assets.

If publication fails, stop asset promotion, preserve evidence, and follow the exact
approved rollback. Do not move tags, overwrite assets, or publish replacements without
explicit authorization.

## Cleanup policy

- The obsolete parent checkout and its untracked `eve-gate5b-base.zip` are never touched.
- Gate 6 uses only the fresh nested clone named in this plan.
- No package, installer, copied runtime, dependency tree, log, audio, screenshot, profile
  backup, manifest, diagnostic helper, or downloaded reference is committed.
- Disposable Gate 6B workspaces/artifacts are removed only after resolving and verifying
  exact absolute paths and only after the user confirms retention is no longer required.
- Historical release assets and Gate 1–5 evidence are immutable.
- Normal source/build cleanup must never target a repository root, profile root,
  installed application, registry, shared cache, or migration backup.

## Stage-gate ledger

| Stage | Status | Evidence | Required approval | What happens next |
|---|---|---|---|---|
| Canonical Gate 6 base | Passed | Fresh clone; exact `0d6605d…`; clean `trunk` | Complete | Preserve base ancestry. |
| Gate 6 tracking issue | Passed | Issue #21, `ready`, execution allowed | Complete | Keep issue state authoritative. |
| Permanent Gate 6 contract | Passed | Commit `e33c9304f6c133867c6a9f0948a943a75fedaca5`; independent parent review | Complete | Preserve the allowlist and stage boundaries. |
| Gate 6A mechanical edits | Passed | Scoped 13-file diff and `eve-gate-6a-evidence.md` | Complete | Commit the reviewed release-preparation head. |
| Gate 6A local Gate A | Passed | `eve-gate-6a-evidence.md`; exact scope/privacy/frozen-boundary audit | Complete | Push and open the draft PR. |
| Gate 6A PR/CI/CodeRabbit | Planned | Future PR and hosted checks | None for draft/review | Leave Ready but unmerged. |
| Gate 6A merge | Deferred | Future merge commit | Explicit authorization | Do not infer from Ready status. |
| Gate 6B exact candidate | Deferred | External artifact/lifecycle evidence | Separate explicit authorization | One package and full lifecycle only. |
| Gate 6C publication method | Blocked | Current tag workflow audit | Explicit method/risk decision | Resolve exact-artifact versus tag-build procedure. |
| Gate 6C merge/tag/release | Deferred | Future canonical/tag/release evidence | Separate explicit authorization | Publish only after all blockers pass. |

## First-turn audit findings

The planning turn verified:

- the fresh nested clone remote is
  `https://github.com/burntcookiedough/eve-windows-dictation.git`;
- local `trunk` and `origin/trunk` were both exactly
  `0d6605d07aa783036d61fc93af7ce043a808f1a6`;
- the tracked worktree was clean before the Gate 6A branch was created;
- `AGENT.md`, ADR-001, the Gate 5 master/evidence, the identity checklist, roadmap,
  version tool, release verification script, manifests, NOTICE/LICENSE, release case
  study, and all GitHub workflows were read;
- `python scripts/version.py check` passed at `0.6.3`;
- the version-tool dry run named exactly six owned files;
- no tracked changelog or release-note file/convention exists; v0.6.3 uses README
  history, an engineering case study, and generated GitHub notes;
- repository/publish metadata targets the standalone Eve repository and local packaging
  explicitly disables publication;
- the tag workflow is publication-active and therefore a Gate 6C control boundary;
- `NOTICE.md` explicitly records an unfinished binary-distribution notice audit;
- formal trademark review remains deferred in the controlling architecture records; and
- stale present-tense Gate 5/identity/roadmap statuses are documentation debt, not
  evidence that merged work is incomplete.

No version, production, package, workflow, profile, registry, application, release, or
personal-data mutation occurred during the planning audit.

## Continuation instructions

A future task resumes without chat history by:

1. reading this file completely;
2. reading issue #21 and confirming `Status: ready` / `Execution Gate: allowed`;
3. verifying canonical base/branch ancestry and a clean worktree;
4. checking the stage-gate ledger for the first incomplete authorized stage;
5. confirming the 13-file Gate 6A allowlist and frozen boundaries;
6. performing only that stage's listed commands and recording fresh evidence; and
7. stopping before any separately gated action.

Use gpt-5.6-sol medium for architecture, release judgment, notice/name risk, review
disposition, and final audit. Use gpt-5.6-terra medium only at safe turn boundaries for
already-decided mechanical version edits, tests, CI, or lifecycle execution. Use
completion-boundary waits for long jobs and avoid unchanged polling. Do not use
subagents unless the user explicitly requests them.

## Failure protocol

On any failed gate:

1. stop the affected stage;
2. preserve only privacy-safe evidence;
3. do not broaden scope or mutate protected machine state;
4. restore the last known safe state using the stage's documented rollback;
5. record what passed, what failed, the exact command/evidence, and the smallest needed
   decision;
6. keep later stages blocked; and
7. never guess past a failed acceptance condition.
