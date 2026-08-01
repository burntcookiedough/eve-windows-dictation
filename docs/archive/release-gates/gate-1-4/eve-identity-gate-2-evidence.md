# Eve identity Gate 2 evidence

## Scope and baseline

Gate 2 is the clean Eve data-boundary change from
[ADR-001](../../../architecture/adr-001-eve-application-identity-migration.md). Implementation began from the
standalone repository's exact merged Gate 1 trunk commit
`5e5b3a3c458d56279e8ece37c51827ce60cfa7a0` on
`codex/eve-fresh-profile-gate-2`.

This gate activates exactly `%APPDATA%\Eve` while retaining `com.murmur.app`, product
name `Murmur`, `Murmur.exe`, installer/shortcut/artifact names, the explicit NSIS GUID,
publish/update configuration, preload globals, `MURMUR_*` names, Python package names,
visuals, and version `0.6.3`. Gate B built and exercised a local Windows candidate, but
did not publish, tag, merge, or change a release.

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
| Zero legacy-root access, including no legacy PID read | Injectable filesystem access record and real Electron controlled-sibling preservation check in `eve-profile-boundary.test.ts`; source/diff audit; packaged candidate selected Eve and the Murmur manifest remained byte-identical until the published rollback was launched. Path-level tracing was removed from this gate, so its absence is an evidence limitation rather than a failed requirement. |
| Redirected parent APPDATA remains supported | Controlled redirected-parent fixture |
| Eve root cannot alias the controlled Murmur fixture | Controlled symlink/junction rejection fixture |
| Missing root initializes; malformed/file/inaccessible root fails closed | Root creation, file-root, canonical-alias, and write-probe tests; sanitized bootstrap error path |
| Fresh settings/window state/History/session/server/helper paths | `userData`/`sessionData` assertions, unchanged consumer path audit, History migration check, and Gate B first-launch artifact inventory |
| No login-item/registry write and no misleading enable result | `login-item-boundary.test.ts`, zero source occurrences of `setLoginItemSettings`, renderer revert/error path, Gate B registry snapshot |
| Malformed, stale, reused, unowned, and rapid-restart PID cases | `server-health.test.ts` PID parser and process-snapshot ownership cases |
| Existing `MURMUR_*` overrides are sufficient | App launcher injects Eve PID/settings paths; no Python server-file diff |
| Shared model cache behavior unchanged | Environment/diff audit; Gate B cache reuse/preservation checks |
| Gate 1 product/installer/release identity unchanged | `server/tests/test_release_config.py`, version consistency, manifest diff audit |
| Uninstall preserves both roots | **Passed.** Frozen `deleteAppDataOnUninstall: false`; the supported candidate uninstaller removed application files while both current profile manifests and the login snapshot remained exact. |
| No sensitive test artifacts | Fixtures use generated temporary roots and synthetic sentinel text; logs and tracked files are scanned before push |

The injectable access record is evidence about root preparation, not proof of all
filesystem behavior. The unpackaged Electron subprocess demonstrates actual singleton
path selection and controlled-sibling preservation, but it is not a packaged filesystem
trace. Neither check may be represented as final full-process non-access proof. Path-level
tracing is explicitly out of scope for this gate and is not a readiness criterion.

### Local smoke-harness correction

An initial uncommitted smoke-harness invocation attempted to redirect Electron with the
child `APPDATA` environment variable alone. Windows known-folder resolution ignored
that variable, so the subprocess selected the actual user's Eve root before exiting. It
did not select the Murmur root. The Eve location was not inspected or removed. The
committed harness instead sets a controlled Electron `appData` path before invoking the
production bootstrap and supplies a controlled pre-bootstrap `--user-data-dir`. This
incident is another reason to retain the available packaged boundary evidence with its
stated limitations. ProcMon/WPR/path tracing is explicitly out of scope for this gate
and is neither a pass criterion nor a readiness blocker.

## Gate A: automated controlled fixtures

Gate A is sufficient to open a draft PR:

| Command | Result on 2026-07-23 |
|---|---|
| `python scripts/version.py check` | Pass; `0.6.3` |
| `bun test` | Pass; 87 tests, 273 assertions, including the controlled real-Electron singleton smoke check |
| `bun run test:history` | Pass |
| `bun run build` | Pass |
| focused Gate 2 tests | Pass; 26 tests, 64 assertions |
| `git diff --check` | Pass before each implementation commit; rerun on final diff |
| `uv sync --extra whisper --group dev --frozen` | Pass; CI-equivalent Windows environment prepared without changing tracked manifests or locks |
| `uv run --no-sync pytest` | Pass; 138 tests |
| explicit standalone tag/release audit | Pass; tag refs unchanged and v0.6.3 asset names, sizes, and SHA-256 digests match Gate 1 evidence |

`bun install --frozen-lockfile` populated the existing ignored dependency directory but
its native `uiohook-napi` postinstall could not link one existing object file locally.
No manifest or lockfile changed; app tests and production builds passed with the
available Windows dependencies. CI performs a clean frozen install.

## Gate B: packaged Windows acceptance

The user approved a current-profile exception after both roots were copied byte-for-byte
to an E:-resident evidence area. File contents and transcript/history data are not
recorded in repository evidence. Shared Hugging Face caches were reused read-only and
were not copied, moved, deleted, or downloaded.

| Check | Result |
|---|---|
| Reviewed source | Exact PR head `758a175203006cf27e3bf5881654c814978eb8e4`; tracked tree clean before packaging |
| Full-runtime candidate | The preserved full-runtime source produced a 887,569-byte recovery installer (SHA-256 `D58922D65215668D30D7A339F114D9715C0AB889BAFAA1C13777B219C07ADF52`) and payload (2,033,993,463 bytes, SHA-256 `8AA10BFA24C7C70F46833A70FBEF56D7DAA4C3C05D9A6AC90F93C7E60AF928F2`). The application payload/closure was equivalent to the earlier verified candidate; only the wrapper hash differed. |
| Runtime closure | Packaged `.runtime\python.exe` imported faster-whisper/CTranslate2, Torch, Torchaudio, and NeMo/Nemotron; required CUDA/native libraries were present; packaged server smoke was healthy at `0.6.3` |
| Fast/Long dictation exercise | **Passed on the recovered full-runtime candidate.** A repository-controlled WAV fixture was converted in memory to 16 kHz mono without persisting content. Fast Dictation delivered a final result for 10.0 seconds through faster-whisper; Long Dictation delivered a final result for 47.334 seconds and emitted `long_dictation_started` plus processing status. Only engine, status, duration, timing, and output-presence metadata were retained. |
| Frozen identity | Product/app/executable/installer/artifact names, `com.murmur.app`, NSIS GUID, version, publish/update target, and v0.6.3 release assets remained unchanged |
| Candidate first launch | Exact `%APPDATA%\Eve` initialized; the packaged server PID was owned by the installed runtime and its current PID-file port `51908` became healthy at `0.6.3` |
| Rapid restart/singleton | Second launch exited successfully; the process tree stabilized to one main process |
| Murmur preservation before repaired relaunch | **Passed.** The fresh current-profile baseline (113 files, 12,673,961 bytes) was byte-identical after candidate install, dictation, repair, and candidate uninstall. This is manifest evidence, not a filesystem trace. |
| Eve preservation | Eve was the active root. The repair and normal candidate uninstall both preserved its exact pre-operation manifest. |
| Login registrations | The current 21-entry Run/StartupApproved raw snapshot (SHA-256 `120B24D7724A3E0106EE1144170519B33D8F7AF56D3ECDF17DF2EDF72424F014`) remained exact across repair and normal candidate uninstall. |
| Candidate same-version repair | **Passed.** An independent, hash-verified Set B payload ran the supported NSIS-web repair with exit `0` in 288.316 seconds. Candidate `app.asar` and runtime closure remained intact; both profiles and the login snapshot were exact; repaired relaunch used its current PID-file port `50452` and became healthy at `0.6.3`. An earlier apparent health failure was an acceptance-harness error: its later probes reused the preceding launch's port `51003` instead of the repaired PID file's port `65325`. No product source change was warranted. |
| Candidate uninstall | **Passed.** The supported uninstaller exited `0` in 20.397 seconds, removed the install root and matching uninstall entry, and preserved both exact pre-uninstall profile manifests and the login snapshot. |
| Published rollback | Official v0.6.3 installer (887,561 bytes, SHA-256 `366088A4266F54EA7C39E2E7FD1FC7177CAC46BF8A4B3F43D58A6D025E15CD33`) and re-downloaded immutable payload (2,034,188,308 bytes, SHA-256 `0B557FDE05853DA1F7C0AEF77CECBAD1FAF8C5FC9314457EA45119D3A69F4FBD`) matched GitHub release metadata. The installer exited `0` in 217.273 seconds; installed `app.asar` matched `98910F5CD2C3A9426ECD7850EE352E47F9C48FB00BB5EEF526220660E69FC8FD`; the server became healthy at `0.6.3` on its current PID-file port `60173`. |
| Murmur state after published launch | The 113-file candidate-cycle baseline matched immediately before rollback launch. Published v0.6.3 may legitimately write to its own Murmur profile after launch; post-launch byte identity is not claimed. |
| Path-level tracing | **Out-of-scope evidence limitation.** ProcMon/WPR/path tracing was explicitly removed from this gate. No path-trace pass or failure is claimed. Static audit, mocked tests, a real Electron controlled-root subprocess, packaged Eve initialization/ownership/readiness, and before/after manifests remain the available boundary evidence |

The residual standard local account `CodexEveGateB16` was created by the user, was not
used for this acceptance path, and expires on 2026-07-25. It remains controlled host
state for later cleanup.

### Fresh Gate A rerun after Gate B

| Command | Result on 2026-07-24 |
|---|---|
| `python scripts/version.py check` | Pass; `0.6.3` |
| `bun test` | Pass; 87 tests, 273 assertions |
| `bun run test:history` | Pass |
| `bun run build` | Pass |
| `uv sync --extra whisper --group dev --frozen` | Pass in an isolated E:-resident environment; tracked manifests and locks unchanged |
| `uv run --no-sync pytest` | Pass; 138 tests |

Gate B lifecycle acceptance is complete. The repaired-health incident was traced to a
stale-port acceptance probe, not the product: `MURMUR_PORT=0` assigns a new port for
each launch, the server writes it to the PID file, and the shipped server manager polls
that current `pidData.port`. Path tracing is not a readiness blocker because it was
explicitly removed from this gate; its absence only limits the available evidence.

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

The approved Gate B host work is recorded above. Further host remediation, marking
ready, merging, tags, and release publication remain no-go actions unless separately
approved; this evidence does not authorize them.
