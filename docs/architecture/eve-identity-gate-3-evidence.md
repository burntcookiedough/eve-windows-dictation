# Eve identity Gate 3 evidence

## Scope and decision

Gate 3 changes the visible Windows product identity from Murmur to Eve while preserving
the merged Gate 2 data boundary and installer chain. Work began from exact trunk commit
`ca9eddbc8c6a40af7194fbb6a2f172109f46b84d`. The implementation commit is
`0cf9da847efa408845014a952e5953a4712b63ff`.

The change keeps version `0.6.3`, `com.murmur.app`, NSIS GUID
`0204d005-75b3-5b31-b1f6-ef2831e2b204`, package name `murmur`, compatibility payload
name `murmur-0.6.3-x64.nsis.7z`, preload bridges, `MURMUR_*` variables, Python package
names, update/release identity, and both profile roots unchanged. AppUserModelID,
startup-registration migration, icons, visual design, homepage, signing, release
publication, dependencies, models, and server behavior remain out of scope.

The final Gate 3 diff contains 25 files: 24 implementation/test/documentation files and
this evidence record. It contains no generated packages, logs, audio output, downloaded
assets, manifests, temporary helpers, dependency changes, or diagnostic artifacts.

## Automated verification

Commands ran natively in Windows PowerShell 7.5.8. Copy-pasteable wrapper invocations
from the repository root are recorded below.

| Check | Windows PowerShell invocation | Result |
|---|---|---|
| Version consistency | `& "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "python scripts/version.py check"` | Passed at `0.6.3`. |
| App suite | `& "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "Set-Location app; bun test"` | 89 passed, 0 failed. |
| Server suite | `& "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "Set-Location server; uv run --no-sync pytest -q"` | 139 passed. |
| Production app build | `& "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "Set-Location app; bun run build"` | Passed. |
| PowerShell and JSON parsing | — | Passed for the changed installer/release scripts and package configuration. |
| `git diff --check` | — | Passed. |
| Scope audit | — | No lockfile, dependency, workflow, runtime, model, server-source, release, or generated-output changes. |

The new regression test checks only visible identity surfaces and explicitly permits
the frozen internal compatibility token `getMurmurTrayIcon`. Its first local run exposed
an overbroad test assertion, not a product defect; the assertion was narrowed before
the complete passing rerun.

## Deterministic package and artifacts

The candidate source worktree did not contain a complete Python runtime, so packaging
did not begin there. Runtime assets were recovered from the preserved exact detached
Gate 2 build tree only after confirming that dependency-defining server paths were
identical. The recovered target contained:

- `.runtime`: 1,885 files and 55,187,715 bytes;
- `.venv`: 30,215 files and 5,023,766,618 bytes;
- Python 3.11.15, Torch 2.6.0+cu124, working NeMo/faster-whisper imports, CUDA available.

Exactly one `bun run package:win` invocation ran from the detached E:-resident worktree
at `0cf9da847efa408845014a952e5953a4712b63ff`. It completed successfully in 831 seconds.
No rejected, partial, or prior candidate payload was reused.

| Fresh output | Bytes | SHA-256 |
|---|---:|---|
| `Eve.Web.Setup.0.6.3.exe` | 887,486 | `8D71E7089677625E693B97E88CB4EB151E95AF06A251765F214FDDF97EF02328` |
| `murmur-0.6.3-x64.nsis.7z` | 2,033,992,770 | `1B2555CE7AE54EF3544DA41C806AD10EFF9CD4788B0F3576F285A4556A3B9899` |
| `latest.yml` | 558 | `40936EF36BF294A1C2A2B4580C9055C1ED77F6A987EA5CBFA508C5B876C2A40E` |

Two independent copies of all three outputs were hash-verified before lifecycle use.
The unpacked executable was `Eve.exe`; its ProductName and FileDescription were `Eve`,
and its ProductVersion was `0.6.3.0`.

## Windows lifecycle acceptance

| Boundary | Result |
|---|---|
| Published baseline | Official Murmur v0.6.3 was healthy with a ready model before candidate installation. |
| Upgrade/install | Set A installed with exit `0` through the frozen GUID and reused the legacy install root. Control Panel showed `Eve 0.6.3`; `Eve.exe`, `Uninstall Eve.exe`, Start-menu shortcut, and desktop shortcut were present. No second uninstall entry was created. |
| Runtime closure | Candidate `/health` reported `0.6.3`, healthy, engine/model ready, CUDA available, and CUDA DLLs present. |
| Controlled smoke | Fast fixture: 10.0 seconds and a non-empty final result. Long fixture: 47.334 seconds, a non-empty final result, and both long-dictation status boundaries. No transcript or audio output was retained. |
| Singleton | A second launch exited without increasing the packaged process count. |
| Same-version repair | Untouched Set B repair exited `0`; the candidate `app.asar` remained SHA-256 `94CE03EAD4483CC98F3F7FDEE761D43053F04E121FE35244C5F6CF0FB5BB2153`; repaired health, model, engine, CUDA, and DLL checks passed. |
| Normal uninstall | `Uninstall Eve.exe /S /currentuser` exited `0`; install root and frozen GUID entry were removed. Murmur remained 113 files/12,690,479 bytes and Eve remained 44 files/3,015,012 bytes. Login-entry fingerprints were unchanged and the shared model cache remained present. |
| Official rollback | The published installer (887,561 bytes, SHA-256 `366088A4266F54EA7C39E2E7FD1FC7177CAC46BF8A4B3F43D58A6D025E15CD33`) and payload (2,034,188,308 bytes, SHA-256 `0B557FDE05853DA1F7C0AEF77CECBAD1FAF8C5FC9314457EA45119D3A69F4FBD`) restored Murmur v0.6.3. Installed `app.asar` matched `98910F5CD2C3A9426ECD7850EE352E47F9C48FB00BB5EEF526220660E69FC8FD`; fresh PID-file health was healthy with ready Whisper, cached model, CUDA and CUDA DLLs available, and zero diagnostics warnings. |

An initial rollback assertion used the candidate-side field name `engine.state`; the
published server correctly reports `engine.status`. The captured response already
showed healthy/ready state, and the corrected schema assertion passed immediately.
This was an acceptance-harness correction, not a product failure.

An unrelated pre-existing shortcut outside the managed install locations was left
untouched. No personal profile contents were inspected or recorded. ProcMon/WPR and
filesystem tracing remained explicitly out of scope.

## Acceptance conclusion

Gate 3 meets its defined boundary: the installed product and current visible UI identify
as Eve, while upgrade/repair/uninstall continuity, fresh Eve profile isolation, both
profile roots, login state, shared models, frozen installer identity, and official
rollback remain intact. Gate 4 AppUserModelID work remains separately gated.
