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

The replacement lifecycle ran from exact fixed head
`c6d9d3a45354d6cd9f5be914843fa928558df9fc`. The detached build tree was clean and
its split Python runtime passed imports for Torch 2.6.0+cu124, CTranslate2 4.6.3,
Faster-Whisper 1.2.1, and NeMo 2.6.2 with CUDA active and the required native DLLs
present.

Exactly one replacement `bun run package:win` invocation ran and exited `0` in
846.6 seconds. The rejected first-cycle outputs were not reused. Two fresh independent
artifact sets were copied and verified against the exact build outputs before Set A
installation and Set B repair.

| Output | Bytes | SHA-256 |
|---|---:|---|
| `Eve.Web.Setup.0.6.3.exe` | 887,518 | `6AA2016A46B93C7F9298ACC134628A79E2D49CFEC20734D782587EE26176DAA6` |
| `murmur-0.6.3-x64.nsis.7z` | 2,034,073,193 | `54963E55DE6CCA3FD26BA0755B59AC99C05878D7D01AD939B3B82D09E6B94547` |
| `latest.yml` | 558 | `BEE065C9A98FFC04914E3354F6E6BAE2997F80FEB06EC24931056B1D17FCC603` |

The manifest wrapper and payload sizes and SHA-512 values matched the generated files.
The packaged and installed candidate `app.asar` SHA-256 was
`D7B188732B504705F3A8277B7A4488714F6B744F76E15EE9F377C77DAD5E4B62`.

| Boundary | Result |
|---|---|
| Same-GUID in-place install | Set A exited `0` in 285.319 seconds. The published install root was reused, exactly one frozen-GUID uninstall entry existed, and it displayed `Eve 0.6.3`. The install did not alter either stopped profile aggregate or any scoped startup value. |
| Installed identity | Only `Eve.exe` was installed. Its product and file metadata were Eve/0.6.3. `Get-StartApps` and both installed shortcuts exposed exact AppUserModelID `io.github.burntcookiedough.eve`. |
| Ordinary launch policy | All three exact user-scope, argument-free legacy names at the installed Murmur path were removed. The controlled unknown entry remained exact, and ordinary launch created no Eve entry. |
| Explicit opt-in and opt-out | The live packaged Settings toggle changed from disabled to enabled and created only the exact Eve name/path registration. The unknown fixture remained and no legacy entry returned. Toggling off removed the exact Eve registration and left the unknown fixture unchanged. |
| Runtime and singleton | Current PID-file ownership matched the packaged Python runtime. Health reported 0.6.3, engine/model ready, CUDA and CUDA DLLs available, and zero warnings. A second Eve invocation exited without changing the five Electron process IDs or server PID/port. |
| Controlled dictation | The repository WAV fixture was converted in memory to 16 kHz mono. Fast Dictation produced a non-empty final result for 10.0 seconds. Long Dictation produced a non-empty final result for 47.334 seconds and emitted both `long_dictation_started` and `long_dictation_processing`. No transcript or audio output was retained. |
| Independent repair | Untouched, hash-verified Set B exited `0` in 269.345 seconds. Candidate `app.asar`, both stopped profile aggregates, and all scoped startup values remained exact. Relaunch used a fresh owned PID-file port and returned ready CUDA health with zero warnings. |
| Normal uninstall | The candidate stopped before the comparison. Uninstall exited `0` in 0.953 seconds and removed the install root and frozen-GUID uninstall key. Both stopped profile aggregates remained exact (Murmur: 113 files/13,353,837 bytes; Eve: 45 files/3,031,628 bytes), all scoped startup values remained exact, and the shared model-cache root remained present. |
| Published rollback | Official wrapper SHA-256 `366088A4266F54EA7C39E2E7FD1FC7177CAC46BF8A4B3F43D58A6D025E15CD33` and payload SHA-256 `0B557FDE05853DA1F7C0AEF77CECBAD1FAF8C5FC9314457EA45119D3A69F4FBD` matched the immutable v0.6.3 release set. Install exited `0` in 208.814 seconds; installed `app.asar` matched `98910F5CD2C3A9426ECD7850EE352E47F9C48FB00BB5EEF526220660E69FC8FD`. Fresh owned PID-file health returned Murmur 0.6.3, ready engine/model, CUDA and DLLs available, and zero warnings. |
| Final host restoration | All ten explicitly captured pre-test startup values were restored and remained exact after the official launch. No broad registry cleanup ran. |

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
The rejected artifacts were not used for acceptance evidence.

### Smoke-harness correction

The first replacement-cycle smoke harness used `/ws`, which the repository does not
route, and received HTTP 403 before sending audio. Repository routing identifies
`/transcribe` as the protocol endpoint. The corrected in-memory invocation passed
immediately. This was a local acceptance-harness error and did not require a product
change or another package run.
