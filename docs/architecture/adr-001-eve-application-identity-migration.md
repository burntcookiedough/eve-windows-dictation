# ADR-001: Cut over to Eve with a fresh data profile

## Status

Proposed. This document authorizes no runtime, installer, registry, or data-path changes.

The companion [cutover checklist](eve-identity-cutover-checklist.md) maps this decision to exact files, release gates, checks, and remaining work.

Product decision: Eve will not import Murmur's History, settings, hotwords, external-server configuration, browser storage, credentials, or other personal state. The old Murmur data directory will be left untouched as an inactive archive.

Trademark review is deferred. It remains separate from this technical design.

## Context

The repository is `burntcookiedough/eve-windows-dictation`, while v0.6.3 still installs Murmur. The later installed-product cutover must give Eve its own identity and clean data profile without breaking the existing NSIS upgrade chain or deleting any legacy files.

The design must protect:

- installer upgrade and uninstall recognition for existing Murmur installations;
- the user's decision not to transfer old personal data into Eve;
- launch-on-login correctness after the executable name changes;
- recovery after an interrupted installation or first launch;
- clear separation from later visual, signing, thin-client, and ASR-engine work.

The project targets Windows and is maintained by a small team. A direct, explicit cutover is safer than a general migration framework that the product no longer needs.

## Current identity inventory

This inventory is based on `trunk` at `fc40ad5a6b37f31b861bd904a0e106813fc81eb8` and a read-only inspection of an installed Windows build. Paths use environment-variable notation and contain no user-specific directory.

### Installer and Windows identity

| Surface | Current value or behavior | Consequence |
|---|---|---|
| Electron package name | `murmur` | Build-tool identifier; change separately from installer continuity work. |
| Product name | `Murmur` | Controls executable and installer-facing names. |
| Application ID | `com.murmur.app` | Used as the Windows Application User Model ID and as input to the default NSIS GUID. |
| Runtime AppUserModelID | `com.murmur.app` | Set explicitly in `app/src/main/index.ts`. |
| Observed NSIS uninstall key | `0204d005-75b3-5b31-b1f6-ef2831e2b204` | Treat as the installed upgrade identity. Confirm on a clean v0.6.3 installation, then freeze it explicitly before changing `appId`. |
| Executable | `Murmur.exe` | Renaming affects startup paths, shortcuts, firewall prompts, and user expectations. |
| Uninstaller | `Uninstall Murmur.exe` | Must remain discoverable across an in-place upgrade. |
| Existing install directory | `%LOCALAPPDATA%\Programs\murmur` | An upgrade should continue to recognize this installation. New clean Eve installs may use an Eve directory after testing. |
| Historical artifacts | `Murmur.Web.Setup.*.exe`, `murmur-*-x64.nsis.7z` | Immutable. Future Eve artifact names do not rename old releases. |
| Publish repository | `burntcookiedough/eve-windows-dictation` | Already migrated and not part of the app cutover. |

Electron Builder documents that NSIS derives a deterministic GUID from `appId` when a target-specific GUID is absent and warns that changing `appId` can break silent upgrades. It also documents product-name changes as supported when installer identity remains stable. This repository targets `nsis-web`, so its options belong under `build.nsisWeb`, not `build.nsis`. See the official [NSIS configuration](https://www.electron.build/docs/nsis/), [NSIS web options](https://www.electron.build/docs/api/electron-builder.interface.nsisweboptions/), and [application configuration](https://www.electron.build/docs/configuration/).

### Legacy Murmur data

| Data | Current location | Eve behavior |
|---|---|---|
| User settings and hotwords | `%APPDATA%\murmur\settings.json` | Do not read or copy. Eve starts with defaults. |
| Window state | `%APPDATA%\murmur\internal.json` | Do not read or copy. |
| History and Insights | `%APPDATA%\murmur\history.db` plus WAL/SHM when present | Do not open, copy, merge, or index. |
| Server settings | `%APPDATA%\murmur\server-settings.json` | Do not import. This prevents transfer of external-server details or other saved configuration. |
| Server PID | `%APPDATA%\murmur\server.pid` | Do not migrate. It may be inspected only to prevent an old owned server from conflicting with Eve startup. A recorded process must pass command-line ownership verification before Eve adopts, stops, or otherwise trusts it, even when the recorded port responds as healthy. |
| Paste helpers | `%APPDATA%\murmur\paste-helper.vbs`, `paste-sendinput.ps1` | Do not copy; Eve regenerates its own helpers. |
| Chromium storage and caches | `Local Storage`, `Network`, `Cache`, `GPUCache`, and related entries | Do not read or copy. This prevents accidental transfer of cookies, browser state, or cached data. |
| Diagnostic traces | for example `hotkey-trace.log` | Do not read or copy. |

The complete `%APPDATA%\murmur` directory remains untouched. Eve will use a distinct root such as `%APPDATA%\Eve`, with the final casing and constant approved during implementation.

Electron documents `userData` as an app-name-derived directory that also contains Chromium-managed state. Eve must set its explicit path before any module constructs Electron Store or calls a service that uses `app.getPath('userData')`. See Electron's [app path documentation](https://www.electronjs.org/docs/latest/api/app#appgetpathname).

### Model caches are separate

Hugging Face model weights live in the standard Hugging Face cache or a user-configured cache, not in Murmur's History/settings directory. They are downloaded third-party runtime assets, not imported Murmur personal data.

Eve may reuse an already verified standard model cache to avoid a multi-gigabyte duplicate download. It must not move, rename, or delete that cache. A later component-pack design may give engine assets an Eve-owned lifecycle; that is outside this identity cutover.

### Runtime and internal identifiers

| Surface | Examples | Decision |
|---|---|---|
| Server environment prefix | `MURMUR_*` | Keep as a compatibility API during the Windows identity cutover. Add `EVE_*` aliases only in a separate proposal. |
| Python package and CLI | `murmur`, `murmur-testui` | Keep during the installed-product rename. |
| Renderer bridge globals | `window.murmurMain` and the overlay bridge | Keep. Renaming internal preload contracts adds risk without changing public ownership. |
| Internal types and helpers | `MurmurMainAPI`, logger text, helper names | Rename only when a focused cleanup provides value. |
| Dormant homepage | old Murmur copy and base path | Keep unpublished until the visual/public-site phase. |
| Icons and color system | current Murmur assets | Handle after identity and installer compatibility are proven. |

## Launch-on-login risk

`app.setLoginItemSettings({ openAtLogin })` defaults to the current executable and uses the AppUserModelID as a Windows value name unless another name is supplied. Electron's [login item documentation](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows) confirms that path, arguments, and name are part of the registration.

A read-only machine audit found three historical entries named `Murmur`, `electron.app.Murmur`, and `com.murmur.app`, pointing at an installed executable and different unpacked candidates. Eve must not import the old `launchOnBoot` setting, so it starts with launch-on-login disabled. The cutover must still neutralize stale known Murmur registrations safely.

The implementation must:

1. enumerate through Electron's supported login-item API where possible;
2. remove only registrations whose names are in an exact compatibility allowlist and whose normalized paths match the published Murmur installation being upgraded;
3. never delete registry values through substring matching;
4. leave unrecognized, development, and unpacked-candidate entries untouched and report a privacy-safe warning;
5. create one Eve registration only after the user enables launch-on-login in Eve;
6. verify the resulting path and enabled state.

## Options considered

| Option | Benefit | Cost and risk | Decision |
|---|---|---|---|
| Import all Murmur data into Eve | Continuity | Transfers personal state the user does not want; copies browser state and risks inconsistent SQLite data | Reject |
| Offer automatic selective import | Some continuity | Adds consent UI, migration code, repair states, and ambiguity about secrets | Reject for the initial Eve cutover |
| Delete Murmur data during upgrade | Clean disk state | Irreversible loss and violates preservation rules | Reject |
| Leave Murmur data untouched and start Eve fresh | Strong privacy boundary, simple recovery, no database migration | Old History is not visible in Eve | Choose |

## Decision

Eve receives a fresh userData root and default settings. It never automatically reads or imports the legacy Murmur data root.

Use compatibility stages so the installer and Windows identity can be tested independently.

### Stage A: compatibility foundation, no visible rename

- Confirm the NSIS uninstall key on a clean published v0.6.3 installation and set `build.nsisWeb.guid` explicitly.
- Confirm the current one-click behavior, then pin `build.nsisWeb.oneClick: true` and `build.nsisWeb.deleteAppDataOnUninstall: false` so the web uninstaller's data policy is explicit.
- Add typed constants for legacy installer identity and future Eve identity.
- Introduce a bootstrap entrypoint that obtains the single-instance lock and selects userData before importing settings, History, clipboard, or server modules.
- Keep selecting `%APPDATA%\murmur` in this stage so behavior remains unchanged.
- Add tests for bootstrap ordering, identity constants, installer GUID, and the no-delete uninstall policy.

This is the smallest safe implementation PR. It changes no visible product or data behavior.

### Stage B: clean Eve data boundary

- Change the bootstrap resolver to select a new Eve userData directory unconditionally for Eve builds.
- Do not test for or inspect Murmur settings, History, Chromium state, or diagnostics.
- Initialize Eve settings, window state, History, server settings, PID file, and generated helpers from clean defaults.
- If the Eve directory exists, use it normally. If it is malformed or inaccessible, stop with repair guidance; do not fall back to Murmur data.
- Permit only a narrow legacy PID ownership check when needed to prevent two managed transcription servers from conflicting. Before adopting a process from the recorded PID and port, require the existing command-line ownership proof. Refuse to adopt or terminate a stale or reused PID owned by another process.
- Leave `%APPDATA%\murmur` byte-for-byte untouched.

### Stage C: visible Eve identity with stable installer continuity

- Change the product, executable, installer display, shortcut, tray strings, and user-facing copy to Eve.
- Preserve the explicit legacy NSIS GUID so existing Murmur installations remain in the upgrade chain.
- Repair exact known launch-on-login registrations. Do not copy the old launch preference; Eve defaults to disabled.
- Decide whether `appId` remains `com.murmur.app` for one bridge release based on clean-machine upgrade, notification, and taskbar tests.
- Do not redesign the interface in this stage. Visual work remains a separate phase.

### Stage D: AppUserModelID cutover

- Change to a distinctive identifier such as `io.github.burntcookiedough.eve` only after Stage C upgrade tests pass.
- Preserve the explicit NSIS GUID.
- Update `app.setAppUserModelId()` and launch-on-login handling together.
- Validate notifications, taskbar grouping, shortcuts, Control Panel metadata, install-over-existing behavior, and uninstall/reinstall behavior.

The exact future AppUserModelID remains separately approved. The example value is not authorized by this ADR.

### Stage E: optional internal cleanup

After the compatibility window, internal `MURMUR_*`, Python package, preload bridge, and test names may be assessed separately. Cosmetic internal renaming is not required for Eve's public identity.

## Legacy-data contract

- Eve never reads transcript rows from Murmur History.
- Eve never imports Murmur settings, hotwords, external-server URLs, browser storage, cookies, credentials, logs, or clipboard-related files.
- Eve never writes into `%APPDATA%\murmur`.
- Install, repair, upgrade, and uninstall never delete `%APPDATA%\murmur`.
- Eve does not display an automatic import prompt during the initial cutover.
- A future manual import tool requires a new explicit product decision and separate threat/privacy review.
- Reinstalling a compatible Murmur build may still expose the old untouched data. Eve-created data remains isolated in Eve's directory.

## Recovery and repair contract

- A Stage A failure changes no user identity or data path.
- A Stage B failure never falls back to or mutates Murmur personal data.
- A Stage C installer failure must leave the previous install recoverable through the frozen NSIS identity.
- Repair may recreate Eve-generated helpers and caches. It must not delete Eve History/settings, Murmur data, model caches, or unrecognized startup entries.
- Uninstall removes program files and current shortcuts but preserves both data roots by default.
- Any future remove-all-data action must list exact paths, distinguish Eve from Murmur, require confirmation, and default to preserving both.

## Acceptance matrix

### Installer and identity

- Clean Eve install with and without a legacy Murmur data directory.
- Upgrade from published v0.6.2 and v0.6.3 installers.
- Existing Murmur install directory and a clean Eve install directory.
- Reinstall the same Eve version.
- Interrupted install and repair.
- Uninstall Eve while preserving Eve data, Murmur data, and model caches.
- Run an explicit nsis-web uninstall regression proving both Eve userData and `%APPDATA%\murmur` survive.
- Verify executable, shortcuts, Start menu, taskbar grouping, AppUserModelID, Control Panel entry, uninstaller, and artifact names.

### Data isolation

- Legacy History containing controlled sentinel rows does not appear in Eve.
- Legacy settings containing controlled sentinel hotwords and external-server values do not appear in Eve.
- Legacy Chromium storage and diagnostic files are never opened by the Eve process during a traced first launch.
- Eve creates a distinct settings file and empty History database.
- Existing valid Eve data is reused without consulting Murmur.
- Malformed or read-only Eve data produces repair guidance without Murmur fallback.
- Process/file tracing confirms Eve does not open Murmur personal files; the only permitted legacy-root access is the separately tested `server.pid` ownership check.
- Migration and startup logs contain no transcript, settings, credential, token, device-label, or personal-path values.

### Startup and lifecycle

- Launch-on-login starts disabled even when Murmur previously enabled it.
- Multiple exact known historical startup registrations are handled safely.
- An unrecognized similarly named entry remains untouched.
- Stale, malformed, live-owned, healthy-but-unowned, and PID-reused-by-an-unrelated-process cases.
- Rapid restart and crash during first Eve initialization.
- First launch works without developer tools on a fresh Windows VM.

### Model cache boundary

- Existing verified Hugging Face model cache is reused without reading Murmur userData.
- Missing cache downloads normally.
- Custom Hugging Face cache environment remains respected.
- Eve uninstall does not delete shared model weights.

## P0 and P1 risks

### P0

- Changing `appId` before freezing and validating the NSIS GUID can break upgrade and uninstall continuity.
- Importing `settings.ts` before setting Eve userData can create or write the wrong directory. The current top-level Electron Store construction makes bootstrap ordering a release blocker.
- Any fallback to `%APPDATA%\murmur` violates the fresh-profile decision and may expose old personal data.
- Adopting a healthy endpoint from `server.pid` without proving process ownership can connect Eve to an unrelated local service or reused PID.
- Broad startup-registry cleanup can remove unrelated user entries.
- Any uninstall configuration that deletes app data can destroy History or settings.

### P1

- Executable renaming can leave stale launch-on-login entries and shortcuts.
- Changing AppUserModelID can reset notification permissions or taskbar grouping.
- Reusing shared model caches must not be confused with importing personal Murmur data.
- Internal `MURMUR_*` churn can break development scripts without improving user-facing identity.
- The dormant homepage contains old product copy and must remain unpublished until redesigned.

## Explicit no-go actions

Until a later implementation phase is approved:

- do not change `com.murmur.app`, `productName`, executable, installer, shortcut, package, or artifact names;
- do not add, edit, or remove registry entries or startup registrations;
- do not read, copy, merge, rename, or delete Murmur History, settings, browser storage, logs, or other personal data;
- do not move or delete `%APPDATA%\murmur`;
- do not delete model caches;
- do not change release tags, historical assets, or update URLs;
- do not combine visual redesign, signing, thin-client packaging, ASR model work, or dependency upgrades with identity changes;
- do not rename internal preload bridges or `MURMUR_*` variables for cosmetic consistency.

## First implementation PR after approval

The smallest safe PR is **identity compatibility scaffolding only**:

1. add typed constants for current and proposed identities;
2. add a bootstrap/userData resolver that still selects the current Murmur path;
3. freeze the clean-install-verified `build.nsisWeb.guid` and explicitly set `build.nsisWeb.oneClick: true` plus `deleteAppDataOnUninstall: false`;
4. add configuration, bootstrap-order, and path-selection tests;
5. prove that v0.6.3 userData, installer names, executable, startup behavior, and release artifacts remain unchanged.

It must not import data, create the Eve data directory, or display Eve inside the installed application.

## Consequences

### Positive

- Eve starts without inherited personal state or ambiguous consent.
- No SQLite, settings, or Chromium migration mechanism is required.
- The legacy directory remains available for manual rollback without being coupled to Eve.
- Installer and identity risks remain testable in small stages.

### Negative

- Existing History and preferences do not appear in Eve.
- Users must configure Eve again.
- Both data directories may remain on disk until the user deliberately removes one outside the application.

### Mitigation

- State the fresh-profile behavior prominently in release notes and first-run UI.
- Never call the cutover a data migration.
- Keep Murmur data untouched and document how to identify both directories without exposing their contents.

## Revisit triggers

Revisit this decision only if the user explicitly requests a manual import feature, Electron Builder changes NSIS GUID behavior, a signed or Store distribution changes installer requirements, or model caches move under application userData.
