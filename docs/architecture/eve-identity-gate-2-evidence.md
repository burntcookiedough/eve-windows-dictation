# Eve identity Gate 2 evidence

## Scope and baseline

Gate 2 is the clean Eve data-boundary change from
[ADR-001](adr-001-eve-application-identity-migration.md). Implementation began from the
standalone repository's exact merged Gate 1 trunk commit
`5e5b3a3c458d56279e8ece37c51827ce60cfa7a0` on
`codex/eve-fresh-profile-gate-2`.

This gate activates exactly `%APPDATA%\Eve` while retaining `com.murmur.app`, product
name `Murmur`, `Murmur.exe`, installer/shortcut/artifact names, the explicit NSIS GUID,
publish/update configuration, preload globals, `MURMUR_*` names, Python package names,
visuals, and version `0.6.3`. It does not package, install, publish, tag, mark ready, or
merge a release.

## Commit and rollback boundaries

| Commit | Boundary | Focused proof | Rollback |
|---|---|---|---|
| `22243b6` | Prepare and validate a profile root; set `userData` and `sessionData` before application imports | Bootstrap and controlled-root tests; main-process build | Revert `22243b6` to return to merged Gate 1 |
| `8e13e21` | Activate exact `Eve`; block login-item writes; route app-side server/helper state; require PID ownership | 25 focused checks; main and renderer builds | Revert `8e13e21` to retain only pre-import scaffolding |
| audit/evidence commit | Remove the bootstrap's legacy default so every caller must select a root; correct the ledger and record Gate A/Gate B boundaries | Bootstrap tests, builds, `git diff --check`, and changed-file audit | Revert this commit to `8e13e21`, then do not ship until the legacy default is removed another way |

The PR ceiling is exactly 20 changed files relative to Gate 1. Python server files,
dependency manifests/locks, workflows, package identity, and release configuration are
outside the allowed diff.

## Data-boundary behavior

The bootstrap order is:

1. resolve Electron's `appData` parent;
2. create and validate its direct `Eve` child, including an exclusive write probe;
3. reject files, symbolic-link/junction roots, canonical redirects, and inaccessible
   roots;
4. set both Electron `userData` and `sessionData` to the prepared root;
5. obtain the single-instance lock scoped to the prepared Eve root;
6. retain `com.murmur.app`;
7. dynamically import the application.

Only after step 7 can top-level Electron Store construction occur. `settings.json` and
`internal.json` therefore initialize under Eve; `HistoryService` opens Eve's
`history.db` and SQLite owns any WAL/SHM siblings there; Chromium session state uses
Eve's `sessionData`; the server receives Eve `server.pid` and `server-settings.json`
through the existing `MURMUR_PID_FILE`/`MURMUR_SETTINGS_FILE` overrides; and clipboard
helpers are generated beneath Eve through the already-overridden `userData`.

Every bootstrap caller must supply a directory name; there is no legacy default or
Murmur fallback. Missing state initializes normally. A malformed or inaccessible selected root throws
before data-consuming imports and shows bounded repair guidance with no fallback.
Malformed/inaccessible Eve PID state fails closed. No generalized migration mechanism
and no server fallback changes were added.

This ordering is not inferred only from a mocked Electron app. The Electron 40.1.0
source for `App::RequestSingleInstanceLock` resolves and creates
`chrome::DIR_USER_DATA`, then constructs `ProcessSingleton` with that path. Gate 2
therefore sets the two Eve paths before calling the real API. The frozen dependency
environment currently runs Electron 40.10.6. A Windows Electron 40.x subprocess smoke
check compiles the actual `bootstrapApplication` implementation into a temporary
controlled fixture, records the real paths at singleton acquisition, and confirms that
the controlled Murmur sibling gains no files and its synthetic sentinel remains
unchanged.

Gate 2 makes zero call to `app.setLoginItemSettings`, including no `false` call. A fresh
profile reads the existing `launchOnBoot: false` default. An enable attempt is rejected
before persistence; the renderer reverts the optimistic toggle and displays an error.
Old Windows registrations are neither read nor edited.

Hugging Face cache discovery remains unchanged. Gate 2 neither redirects, moves, nor
deletes the shared cache.

## Definition of done

| Requirement | Test or evidence |
|---|---|
| Exact `%APPDATA%\Eve` selected | `bootstrap.test.ts` ordering assertions plus the real Electron controlled-root subprocess smoke check |
| Selection precedes singleton acquisition, Store, History, server, helper, and session consumers | Real Electron lock-time path record, mocked regression ordering, dynamic-import ordering, and successful full main-process build |
| Zero legacy-root access, including no legacy PID read | Injectable filesystem access record and real Electron controlled-sibling preservation check in `eve-profile-boundary.test.ts`; source/diff audit; privacy-normalized packaged Process Monitor/ETW proof remains Gate B |
| Redirected parent APPDATA remains supported | Controlled redirected-parent fixture |
| Eve root cannot alias the controlled Murmur fixture | Controlled symlink/junction rejection fixture |
| Missing root initializes; malformed/file/inaccessible root fails closed | Root creation, file-root, canonical-alias, and write-probe tests; sanitized bootstrap error path |
| Fresh settings/window state/History/session/server/helper paths | `userData`/`sessionData` assertions, unchanged consumer path audit, History migration check, and Gate B first-launch artifact inventory |
| No login-item/registry write and no misleading enable result | `login-item-boundary.test.ts`, zero source occurrences of `setLoginItemSettings`, renderer revert/error path, Gate B registry snapshot |
| Malformed, stale, reused, unowned, and rapid-restart PID cases | `server-health.test.ts` PID parser and process-snapshot ownership cases |
| Existing `MURMUR_*` overrides are sufficient | App launcher injects Eve PID/settings paths; no Python server-file diff |
| Shared model cache behavior unchanged | Environment/diff audit; Gate B cache reuse/preservation checks |
| Gate 1 product/installer/release identity unchanged | `server/tests/test_release_config.py`, version consistency, manifest diff audit |
| Uninstall preserves both roots | Frozen `deleteAppDataOnUninstall: false`; actual install/repair/uninstall proof deferred to Gate B |
| No sensitive test artifacts | Fixtures use generated temporary roots and synthetic sentinel text; logs and tracked files are scanned before push |

The injectable access record is evidence about root preparation, not proof of all
filesystem behavior. The unpackaged Electron subprocess demonstrates actual singleton
path selection and controlled-sibling preservation, but it is not a packaged filesystem
trace. Neither check may be represented as final full-process non-access proof; that
acceptance remains Gate B.

### Local smoke-harness correction

An initial uncommitted smoke-harness invocation attempted to redirect Electron with the
child `APPDATA` environment variable alone. Windows known-folder resolution ignored
that variable, so the subprocess selected the actual user's Eve root before exiting. It
did not select the Murmur root. The Eve location was not inspected or removed. The
committed harness instead sets a controlled Electron `appData` path before invoking the
production bootstrap and supplies a controlled pre-bootstrap `--user-data-dir`. This
incident is another reason the packaged privacy boundary is not finally accepted until
Gate B tracing passes.

## Gate A: automated controlled fixtures

Gate A is sufficient to open a draft PR:

| Command | Result on 2026-07-23 |
|---|---|
| `python scripts/version.py check` | Pass; `0.6.3` |
| `bun test` | Pass; 86 tests, 265 assertions, including the controlled real-Electron singleton smoke check |
| `bun run test:history` | Pass |
| `bun run build` | Pass |
| focused Gate 2 tests | Pass; 25 tests, 56 assertions |
| `git diff --check` | Pass before each implementation commit; rerun on final diff |
| `uv sync --extra whisper --group dev --frozen` | Pass; CI-equivalent Windows environment prepared without changing tracked manifests or locks |
| `uv run --no-sync pytest` | Pass; 138 tests |
| explicit standalone tag/release audit | Pass; tag refs unchanged and v0.6.3 asset names, sizes, and SHA-256 digests match Gate 1 evidence |

`bun install --frozen-lockfile` populated the existing ignored dependency directory but
its native `uiohook-napi` postinstall could not link one existing object file locally.
No manifest or lockfile changed; app tests and production builds passed with the
available Windows dependencies. CI performs a clean frozen install.

## Gate B: packaged disposable Windows acceptance

Gate B requires separate approval and must pass before merge. It uses a disposable
Windows account or VM, never the real user profile:

- install published v0.6.3, then install the same-version Gate 2 candidate;
- same-version repair and rapid restart;
- controlled Murmur fixtures containing synthetic settings, History/WAL/SHM, Chromium,
  PID, helper, log, credential-like, and startup-preference sentinels;
- clean first launch proving Eve defaults, empty History, fresh browser state, fresh
  server state, and Eve helper generation;
- stale, reused, malformed, owned, unowned, and healthy-but-unowned Eve PID cases;
- shared Hugging Face cache reuse without moving or deleting it;
- uninstall preserving both controlled roots and the shared cache;
- rollback to checksum-verified published v0.6.3 and responsive launch;
- exact before/after snapshots of uninstall identity, install files, shortcuts,
  login-item registrations, roots, tags, releases, and published assets.

Process Monitor or ETW filters must be scoped to the candidate process tree and the two
controlled fixture roots. Exported evidence must replace account names and temporary
prefixes with stable tokens, retain operation/result/path-class fields needed for audit,
exclude file contents and unrelated processes, and prove zero operation beneath the
controlled Murmur token. Real `%APPDATA%\murmur` contents must never be read or traced.

## Stop conditions

Stop and revert the latest commit if the implementation:

- opens any controlled legacy-root path;
- falls back to Murmur after an Eve failure;
- adopts or terminates an unverified process;
- makes any login-item or registry write;
- changes product, installer, AppUserModelID, package, internal bridge, environment,
  visual, dependency, version, tag, release, or update identity;
- touches a Python server file without a demonstrated failure of the explicit app-side
  overrides;
- requires packaging or real-host mutation to make Gate A pass.

Packaging, host installation, registry mutation, marking ready, merging, tags, and
release publication remain explicit no-go actions until their later approvals.
