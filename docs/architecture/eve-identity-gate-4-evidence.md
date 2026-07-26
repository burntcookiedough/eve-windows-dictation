# Eve identity Gate 4 evidence

## Scope and decision

Gate 4 starts from exact merged Gate 3 trunk commit
`822a353d9e232a1b365b61c972db4195ac23ba48`. The approved Eve application ID and
Windows AppUserModelID is:

```text
io.github.burntcookiedough.eve
```

The version remains `0.6.3`. The NSIS GUID remains
`0204d005-75b3-5b31-b1f6-ef2831e2b204`, preserving the published Murmur upgrade and
uninstall chain. Product, executable, wrapper, shortcut, internal package, compatibility
payload, preload, environment, Python, update/release, profile, model, and visual
identities remain unchanged from Gate 3.

The Gate 4 file ceiling is 14 tracked files:

- six production/configuration files for package identity, process identity, startup
  policy, IPC ordering, and accurate failure copy;
- four direct regression files;
- `README.md`, ADR-001, the cutover checklist, and this evidence record.

No dependency, lockfile, workflow, server-source, runtime, model, homepage, release,
generated, downloaded, profile, registry-export, log, audio, or package output belongs
in the diff.

## Startup policy

- Ordinary packaged launch creates no Eve login item. It enumerates through Electron
  and writes only when an exact stale project-owned legacy registration is present.
- Unpackaged and non-Windows callers cannot create a registration.
- A boolean user toggle is validated before any operating-system or settings write.
- Enabling creates the exact Eve user registration for the current packaged executable
  with no arguments and verifies its exact path and enabled state before persistence.
- Both ordinary packaged launch and opt-in enumerate Electron's `launchItems` and
  remove allowlisted names `Murmur`, `electron.app.Murmur`, and `com.murmur.app` only
  when they are user-scope, argument-free, and resolve exactly to
  `%LOCALAPPDATA%\Programs\murmur\Murmur.exe`.
- Development paths, machine-scope entries, argument-bearing entries, different casing,
  unknown names, and unrelated entries remain untouched. Only a count of possible
  legacy candidates is logged; names and paths are not logged.
- Disabling removes only the exact Eve name/path registration.
- A failed verification does not persist the setting and makes a best-effort exact Eve
  registration rollback. It never performs substring-based deletion or direct registry
  access.

## Gate A automated verification

Results on 2026-07-27:

| Check | Result |
|---|---|
| `python scripts/version.py check` | Passed at `0.6.3`. |
| Focused identity/startup/profile tests | 19 passed, 0 failed, including a real Electron controlled-root singleton check. |
| Full `bun test` | 95 passed, 0 failed. |
| `bun run test:history` | Passed. |
| `bunx tsc -p tsconfig.main.json --noEmit` | Passed. |
| `bun run build` | Main, preload, and renderer production builds passed. |
| `uv run --no-sync pytest -q` | 139 passed. |
| Frozen dependency preparation | `bun install --frozen-lockfile` and `uv sync --extra whisper --group dev --frozen` passed with tracked manifests and locks unchanged. |
| PowerShell/JSON parsing and `git diff --check` | Passed. |
| Changed-file and privacy/release audit | Exactly 14 tracked files; no dependency, lock, workflow, server-source, runtime, model, homepage, release, or generated-output diff. |

The first fresh server environment intentionally installed only the base and development
groups. That run passed 136 tests and failed three imports because the optional
faster-whisper/Hugging Face packages were absent. Adding the locked `whisper` extra—the
documented Gate A environment—changed no tracked file, and the complete 139-test rerun
passed. This was environment preparation, not a product defect.

## Gate B Windows lifecycle acceptance

The separately authorized lifecycle will use exactly one package invocation from an
exact detached candidate head after validating the complete runtime/engine/CUDA
closure. Independent hash-verified copies will be made before repair consumes a
payload. Acceptance must cover:

- published Murmur v0.6.3 baseline and same-GUID Eve upgrade;
- one Control Panel identity and the legacy install chain;
- package/runtime AppUserModelID, taskbar grouping, notifications, permissions,
  shortcuts, executable, uninstaller, and install location;
- default launch-on-login disabled with no startup write;
- exact user opt-in creating only the Eve entry;
- exact known legacy installed-path entries removed and unknown controlled fixtures
  untouched;
- current PID-file health, controlled Fast/Long smoke, and singleton;
- independent same-version repair;
- normal uninstall preserving both profile manifests, shared model-cache presence, and
  controlled unknown login state;
- checksum-verified official rollback and fresh current PID-file health.

No personal profile contents, transcript text, audio output, unknown startup value
contents, or shared model files may be recorded or deleted. No tag, release, asset,
update manifest, merge, or publication is authorized.

### Rejected first candidate

The first exact-head package run at commit
`ee36b07fc20ee131fd2f2d6a755cf02f1c8fb4c5` was rejected during the ordinary-launch
startup boundary. Electron filters `launchItems` by the `path` supplied to
`getLoginItemSettings`; querying with `Eve.exe` therefore did not enumerate exact
legacy registrations whose path was `Murmur.exe`. The controlled host check found the
legacy entry still present, while the unknown fixture remained untouched and no Eve
entry was created.

Lifecycle testing stopped at that boundary. The candidate was normally uninstalled,
the checksum-verified official v0.6.3 rollback was restored and became healthy with a
ready Whisper engine, CUDA active, required CUDA DLLs present, and zero diagnostics
warnings. All ten explicitly captured startup values were restored exactly; no broad
registry cleanup was performed.

The correction queries and verifies `launchItems` using the exact allowlisted legacy
executable path. The fake Electron boundary now applies the same path-and-arguments
filter, so the regression fails if reconciliation queries the current Eve executable.
The rejected artifacts are not eligible for further acceptance evidence. A fresh
exact-head package is required before Gate B can resume.
