# Eve identity cutover checklist

## One-minute brief

Eve will be a new Windows application identity, but it must remain in Murmur's existing NSIS upgrade chain. It will start with an empty History and default settings in a separate Eve directory. It will not import or delete Murmur History, settings, hotwords, external-server configuration, browser storage, credentials, logs, or startup preference. The old Murmur data directory stays inactive and untouched. Generic Hugging Face model weights may be reused because they are downloaded runtime assets outside Murmur userData. Implementation is split into compatibility scaffolding, the fresh Eve data boundary, the visible product rename, and the later AppUserModelID cutover. Each step gets its own PR and Windows acceptance gate.

The controlling architecture decision is [ADR-001](adr-001-eve-application-identity-migration.md).

## Fixed decisions

- Repository: `burntcookiedough/eve-windows-dictation`.
- Display product direction: Eve.
- Trademark work: deferred, not treated as complete.
- Murmur personal data: no import, no fallback, no automatic prompt, no deletion.
- Eve data: a distinct fresh profile.
- Shared model cache: may be reused without reading Murmur userData.
- Existing installer chain: preserve through an explicit NSIS GUID.
- Visual redesign: later phase.
- Thin-client and new ASR profiles: later phase.

## Audit coverage

The pre-checklist repository audit found 87 tracked files containing `murmur` after excluding the main dependency lockfiles. Many are historical documentation, internal compatibility names, or sample prose rather than public product identity. They must be classified, not replaced mechanically.

High-signal counts at the ADR baseline:

| Pattern | Lines | Files | Treatment |
|---|---:|---:|---|
| `com.murmur.app` | 8 | 4 | Installer/AppUserModelID compatibility work. |
| `%APPDATA%\murmur` | 22 | 5 | Legacy data boundary; Eve must not read or modify it. |
| `window.murmurMain` | 49 | 9 | Internal preload contract; retain. |
| `MURMUR_*` | 87 | 27 | Runtime/developer compatibility API; retain during cutover. |
| `Murmur.exe` | 8 | 5 | Installer, startup, smoke-test, and documentation cutover. |
| `Uninstall Murmur` | 3 | 3 | Installer upgrade/uninstall verification. |
| old repository URLs | 5 | 3 | Dormant homepage and a historical setup document; update only in their owning phase. |

These counts are audit evidence, not a target of zero. A zero-result rename would be unsafe because it would erase compatibility constants and historical descriptions.

## File-by-file implementation map

### Gate 1: compatibility scaffolding

These files define identity and startup ordering. The first implementation PR may touch only this group plus focused tests.

| File | Current responsibility | Required change |
|---|---|---|
| `app/package.json` | `appId`, `productName`, target, publish configuration | Add the clean-install-verified `build.nsisWeb.guid`; pin `build.nsisWeb.oneClick: true` and `deleteAppDataOnUninstall: false`. Keep all visible Murmur values. |
| `app/src/main/index.ts` | AppUserModelID, single-instance lock, service startup | Split a minimal bootstrap that resolves userData before importing data consumers. Keep `com.murmur.app`. |
| new identity module | No centralized identity constants exist | Define typed legacy and proposed identifiers without activating Eve values. |
| `server/tests/test_release_config.py` | Release/build configuration contract | Assert target-specific `nsisWeb` GUID, one-click/no-delete policy, unchanged product name, app ID, target, and repository. |
| new app bootstrap tests | No ordering contract exists | Prove userData selection occurs before settings/History/server modules initialize. |

Exit condition: packaged names, executable, data path, startup behavior, release assets, and v0.6.3 compatibility remain unchanged.

### Gate 2: fresh Eve profile

This group owns mutable state. The fresh-profile PR must not include visible renaming.

| File | Current Murmur dependency | Eve treatment |
|---|---|---|
| `app/src/main/services/settings.ts` | Constructs `settings.json` and `internal.json` stores at module load | Initialize only after bootstrap selects Eve userData. Do not read legacy JSON. |
| `app/src/main/services/history.ts` | Opens `history.db` under userData | Create a new empty Eve database. Never open legacy History. |
| `app/src/main/services/server-manager.ts` | Uses userData for `server.pid` and `server-settings.json` | Use Eve paths supplied through the existing app-side overrides. Do not read the legacy PID. Require PID, executable, command-line, and creation-epoch ownership proof before adopting or terminating a process referenced by Eve's PID file. |
| `app/src/main/services/clipboard.ts` | Writes paste helper scripts under userData | Generate new Eve helpers. Do not copy old scripts. |
| `app/scripts/clear-data.js` | Targets the Murmur directory | Replace with an Eve-specific development helper. It must never target both roots. |
| `server/src/pidfile.py` and `server/justfile` | Standalone fallback paths use `murmur` | Keep compatibility fallbacks unless a separately tested Eve override is passed by the app. |
| `server/src/config.py` | Accepts `MURMUR_SETTINGS_FILE` | Keep the environment contract; the Electron launcher supplies the new Eve file path. |

Exit condition: traced first launch performs zero access against the controlled Murmur
root, with no legacy PID exception. Eve starts with defaults and empty History, and both
directories survive uninstall.

Focused lifecycle tests must cover a stale PID file, a PID reused by an unrelated process, a healthy endpoint whose recorded PID is not owned, and a verified owned server. No unrelated process may be adopted or terminated.

### Gate 3: visible Eve name

This group changes what users see. It follows installer and data isolation gates.

| Area | Files | Required work |
|---|---|---|
| Packaged identity | `app/package.json` | Set product/executable/installer/shortcut display values while preserving the explicit NSIS GUID. |
| App shell | `app/src/main/index.ts`, `app/src/main/services/tray.ts`, `app/src/main/windows/main.ts` | Replace user-facing Murmur strings; do not rename internal APIs in the same PR. |
| Main window | `TitleBar.svelte`, `SettingsView.svelte`, renderer `index.html` | Replace visible product copy and accessible labels. |
| Overlay | overlay `index.html` and user-visible warning copy | Replace visible name only. Keep `window.murmur` bridge stable. |
| Diagnostics | `diagnostics-report.ts`, user-facing server diagnostics | Report Eve as the product while retaining compatibility identifiers only where technically required. |
| Installation checks | `scripts/installer-smoke.ps1`, `scripts/release-verify.ps1`, related tests | Accept and verify Eve executable, installer, shortcut, uninstaller, and artifact names. Preserve legacy-upgrade fixtures. |
| Build docs | `README.md`, `BUILDING.md`, active Windows setup docs | Describe Eve current behavior while keeping historical releases labelled Murmur. |

Exit condition: an upgrade from published Murmur succeeds, Eve starts with a fresh profile, old personal data stays untouched, and launch-on-login defaults to disabled.

### Gate 4: AppUserModelID cutover

| File or system | Required work |
|---|---|
| `app/package.json` | Change `appId` only after the exact future ID is approved; retain explicit NSIS GUID. |
| `app/src/main/index.ts` | Change `app.setAppUserModelId()` with the packaged ID. |
| `app/src/main/ipc/handlers.ts` | Register only Eve launch-on-login after user opt-in; reconcile exact known legacy registrations. |
| Windows installation | Verify taskbar grouping, notifications, shortcuts, uninstall key, install location, repair, and upgrade. |

Exit condition: no duplicate installer entry, no stale enabled startup entry, and no loss of the existing uninstall/upgrade path.

### Keep stable during the cutover

These names are internal or compatibility surfaces. They are not evidence that public renaming is incomplete.

- `window.murmurMain`, `window.murmur`, preload API types, and renderer call sites;
- `MURMUR_*` server and development environment variables;
- Python distribution/CLI names such as `murmur` and `murmur-testui`;
- version-script lockfile matching for the current Python package;
- protocol module names and test fixture package paths;
- historical release names, tags, checksums, PRs, and case-study evidence.

### Defer to later phases

| Scope | Files or assets | Reason |
|---|---|---|
| Visual system | `app/resources` icons and renderer styling | Requires its own design and accessibility review. |
| Public homepage | `homepage/**` and Pages workflow | Current site is dormant and Pages is not configured. Rebuild after visual identity. |
| Historical research wording | benchmark and VRAM research docs | Update only for clarity; do not rewrite historical measurements as Eve results. |
| Thin-client distribution | release workflow, component manifests, engine packs | Separate high-risk packaging architecture. |
| Internal rename cleanup | preload globals, Python packages, env prefix | High churn with no user-facing benefit. |

## Surgical execution order

1. Capture baseline Git ref, installer configuration, release asset inventory, NSIS key, installed files, startup registrations, and both data-root existence states without reading personal contents.
2. Merge compatibility scaffolding with no behavior change.
3. Build and install that bridge on a clean VM and over published v0.6.2/v0.6.3.
4. Implement the fresh Eve data root without visible rename.
5. Trace filesystem access and prove Murmur personal files are not opened.
6. Change visible product/installer names while preserving the explicit NSIS GUID.
7. Repair exact known startup entries and leave unknown entries untouched.
8. Run the complete upgrade, clean-install, repair, uninstall, and rollback matrix.
9. Change AppUserModelID only in a later focused PR if the prior release proves stable.
10. Begin visual design only after identity acceptance is complete.

## Required checks for every implementation PR

- `python scripts/version.py check`;
- focused app or server tests for the changed boundary;
- full app tests and production build;
- full server tests when launcher/server behavior changes;
- `git diff --check` and exact changed-file scope audit;
- privacy scan of logs and test artifacts;
- clean Windows VM acceptance when installer or identity changes;
- nsis-web uninstall regression proving both Eve and Murmur data roots survive;
- exact pre/post registry, shortcut, install-directory, and data-root comparison;
- on controlled fixtures, confirmation that `%APPDATA%\murmur` sentinel hashes are
  unchanged; in a disposable Windows account/VM, use a privacy-normalized filesystem
  trace to prove the candidate never opens the controlled legacy root. Never trace or
  inspect a real user's Murmur contents;
- confirmation that no release, tag, or historical asset changed.

## Remaining-work ledger

| Work | Status | Approval needed |
|---|---|---|
| Repository detachment and rename | Complete | No |
| Placement-ready repository documentation | Complete | No |
| Fresh-profile ADR and cutover checklist | Complete in PR #14 | No |
| Derive and cross-check the published v0.6.3 NSIS key | Complete; see Gate 1 evidence | No |
| Confirm NSIS key from published v0.6.3 installation | Complete in Gate 1 host acceptance | No |
| Select final Eve data-root casing | Complete: exact `%APPDATA%\Eve` | No |
| Select final AppUserModelID | Pending; Gate 4 only | Separate approval |
| Compatibility-scaffolding implementation | Complete in merged PR #15 at `5e5b3a3` | No |
| Fresh Eve profile implementation | Gate A passes on `codex/eve-fresh-profile-gate-2`; Gate B candidate launch/rollback evidence captured; path tracing is an out-of-scope evidence limitation, while same-version repair did not pass | Successful supported repair check before Ready |
| Visible installed-product rename | Pending | Separate approval after data isolation passes |
| AppUserModelID cutover | Pending | Separate approval after upgrade acceptance |
| Visual identity and homepage | Pending | Later design phase |
| Thin-client/component packs and ASR profiles | Pending | Later technical phase |

## Stop conditions

Stop the current change immediately if it:

- reads or writes Murmur History, settings, browser storage, credentials, logs, or hotwords;
- changes the NSIS identity without an explicit verified GUID;
- creates an Eve startup entry before the user opts in;
- deletes either data root or shared model cache;
- produces two active installer/uninstall entries for one upgrade path;
- requires visual redesign, dependency upgrades, model changes, or release publication to succeed;
- cannot explain recovery using only the previous installer and untouched data directories.
