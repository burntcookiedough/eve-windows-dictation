# Eve Gate 5A evidence

Date: 2026-07-27

Canonical base: `20a781f78d638bc5884a8e85511cf3c8507eca4b`
Planning contract commit: `1b4de8e`

## Scope and outcome

Gate 5A implements the selected application and noninteractive overlay direction on
the existing Eve renderer. It does not package the application and does not begin
Gate 5B.

Production navigation is History / Insights / Settings. Lab remains source-preserved
behind `import.meta.env.DEV`. Invalid internal view values resolve to History. Server,
Engine, logs, diagnostics, start, stop, restart, and external-server behavior are
preserved under Settings > Advanced.

Insights uses actual `InsightsResponse` values for the approved stacked metric
panels, bar graph, activity dots, line graph, and per-day table. No reference
placeholder model, endpoint, metric, or setting became product behavior.

The overlay remains click-through and non-focusable. Its transcript is fixed to two
lines and auto-follows the newest text without an operable scrollbar. Pause, End,
Retry, and manual review are absent and deferred.

## Local validation

| Check | Result |
|---|---|
| Focused Gate 5 tests | Passed: 14 |
| Complete app test suite | Passed: 107 |
| TypeScript main configuration | Passed |
| Main-process build | Passed |
| Renderer production build | Passed |
| Complete server test suite | Passed: 139 using the existing Gate 4 full test runtime with the current Gate 5A source tree |
| Python lock validation | Passed: `uv lock --check` |
| App/server manifests and lockfiles | Unchanged from `origin/trunk` |
| Reference hashes | Passed; exact hashes match the master plan |
| Changed-file ceiling | Passed; scoped below the maximum of 28 |
| Package/install lifecycle | Not run; forbidden for Gate 5A and reserved for the final Gate 5B resource-changing head |

The first server attempt used the host Python environment and lacked optional Whisper
and SoundFile dependencies. It collected 139 tests and passed 137. The authoritative
rerun used the already-proven Gate 4 Python 3.11 test runtime without installing or
mutating dependencies; all 139 tests passed.

`bun audit --production` reported the existing lockfile baseline: one high
`fast-uri` advisory and two moderate `ajv` advisories through existing dependencies.
Gate 5A changes neither manifest nor lockfile and does not expand dependency risk.

## Visual and accessibility evidence

The full design record is in `design-qa.md`. Synthetic, untracked captures are stored
outside the repository under the local Gate 5A visualization directory.

Completed checks:

- exact-reference, same-state side-by-side application comparison;
- overlay Resting, Active geometry, Split, and Long transcript review;
- 100%, 125%, 150%, and 200% Electron device-scale captures;
- 200% text zoom/reflow capture;
- forced-colors and reduced-effects captures;
- numeric WCAG 2.2 AA contrast calculation;
- keyboard-only order capture;
- accessibility-tree names and roles for the main History flow;
- focus trap, Escape, and opener-focus restoration guards for the hotkey dialog;
- static assertions for native Windows title-bar overlay, drag region, and removal of
  custom caption buttons;
- static and rendered proof that the overlay is noninteractive and cannot take focus.

Native caption behavior remains OS-owned through Electron `titleBarStyle: 'hidden'`
and `titleBarOverlay`, preserving minimize, maximize, close, Alt+Space, and Windows 11
Snap Layout behavior. No renderer control overlays the native caption area.

## Frozen-boundary audit

Verified unchanged from `origin/trunk`:

- version `0.6.3`;
- AppUserModelID and builder app ID `io.github.burntcookiedough.eve`;
- NSIS GUID `0204d005-75b3-5b31-b1f6-ef2831e2b204`;
- `app/package.json`, `app/bun.lock`, `server/pyproject.toml`, and `server/uv.lock`;
- workflows, homepage, release configuration, updater behavior, protocols, runtime,
  engines, startup policy, profiles, shared cache, and internal compatibility names.

No profile was opened or inspected. No package, installer, audio, log, personal
screenshot, downloaded reference, or diagnostic artifact is tracked.

## Pull request handoff

Local Gate A passed from implementation commit `fad9515`. Before Ready:

1. push the minimal branch and open a draft PR;
2. wait for CI;
3. mark Ready only after local and hosted checks pass;
4. trigger and disposition the real CodeRabbit review;
5. rerun affected validation for any justified fix;
6. audit exact head, scope, and clean worktree.

Leave Gate 5A Ready but unmerged. Gate 5B requires separate authorization and must
branch from the accepted Gate 5A state.
