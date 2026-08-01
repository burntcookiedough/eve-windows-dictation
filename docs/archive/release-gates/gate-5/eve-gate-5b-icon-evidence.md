# Eve Gate 5B icon-resource evidence

## Scope and accepted head

Gate 5B adds the original Eve cactus master, deterministic Windows icon
derivatives, runtime selection for light, dark, and High Contrast tray variants,
and direct regression coverage. It starts from canonical Gate 5A merge
`c7a5e8b596337396b6754cf64e7b535fcb1a0a31` and uses resource head
`fd8de14f93460aa72df62298aea109b35645df5a`.

The Gate 1–4 boundaries remained frozen:

- version `0.6.3`;
- AppUserModelID `io.github.burntcookiedough.eve`;
- NSIS GUID `0204d005-75b3-5b31-b1f6-ef2831e2b204`;
- legacy install chain, profiles, startup policy, shared model cache, protocols,
  updater, runtime/engine behavior, and internal compatibility names.

No dependency, lockfile, workflow, server-source, profile, cache, startup,
release, tag, or publication change belongs to this gate.

## Resource design and provenance

`app/resources/eve-cactus-master.png` is the single 2048 x 2048 RGBA source of
truth. Its generation prompt, preparation, privacy statement, and originality
boundary are recorded in `app/resources/eve-cactus-provenance.md`. The tracked
`app/scripts/build-icons.mjs` script uses the locked Electron `nativeImage`
implementation and no new dependency.

The resulting application ICO contains 16, 20, 24, 32, 40, 48, 64, 128, and
256 px entries. Separate tray resources provide a dark glyph for a light
taskbar, a light glyph for a dark taskbar, and a two-tone High Contrast glyph.
Runtime selection follows Electron native-theme state and refreshes on theme
updates.

Focused resource verification passed:

- the 2048 px master is RGBA and retains the specified optical padding;
- the ICO contains every required size;
- all derivatives have usable alpha and remain recognizable at small sizes;
- deterministic `build:icons -- --check` regeneration passed;
- visible identity and native-theme selection regression tests passed;
- packaged Eve showed the expected monochrome cactus in the title bar alongside
  the accepted Gate 5A shell.

The installed screenshot was diagnostic evidence outside the repository.
Static/resource tests remain authoritative for tray light, dark, High
Contrast, ICO-entry, and derivative-reproducibility behavior.

## Exact-head package evidence

The accepted package workspace was clean at exact head `fd8de14f…`.
Direct main and renderer production builds passed. One accepted direct
`electron-builder --win --publish never` package completed with zero stderr;
no second accepted package was run.

Two independent candidate artifact sets were copied and hash-verified:

| Artifact | Bytes | SHA-256 | SHA-512 |
|---|---:|---|---|
| `Eve.Web.Setup.0.6.3.exe` | 654,540 | `4F2EB3492E0AA9D65A0454C4A0735005D6044B3018DCCB6BD473E39585D81C98` | `0B1F42329FA02906A30AA7A35037750D5DD2ACF7BE1F2665462663EF1B41D17A19F50BE1516FF72D5036897F7BEECE869EBD25D4F6F8AC6E62DB4E800FC1E476` |
| `murmur-0.6.3-x64.nsis.7z` | 2,033,635,534 | `B81CF268CBA2123A9F17E5CDACFD50E2F70F687C409AB704DA0FE7384DB835DC` | `bey/Dg96kO7QgIcteh5OUGBvBshNYfyHg1cOlfMctgidltcxY00JN/75991enT4Xim/35RYZCXLvCKH349e7sQ==` (manifest encoding) |
| `latest.yml` | 558 | `7C51D30262E9E8745B0EB225DE6F930BE559B15296B54B3A8C7E2CE73E1B978B` | `E710480C92E683E68B9774A2198A90BC327047AF88CC547CBCC1944BBC16AA194F6188680CC1CD1CC99210E346606D80FF118EC469E28DA3E1C8183A518B32BD` |

The unpacked closure contained `Eve.exe`, `app.asar`, the embedded Python
runtime and virtual environment, 14 required CUDA/cuDNN/cuBLAS/NVRTC DLLs,
CTranslate2, and ONNX Runtime. Installed candidate `app.asar` SHA-256 was
`7324CDBFA530F6AD0CFFF19433AF78E307ED4E1C00B272B064ABFBBADFB20D18`.

## Privacy-safe Windows lifecycle

The NSIS-web wrapper's automatic payload resolution was ambiguous in the first
bounded launch. Inspection of the generated `installer.nsh` established the
supported explicit `--package-file` option, which bypasses download/discovery
and selects the already hash-verified same-set payload. The accepted install
and repair used `/S --package-file=<same-set verified payload>`. The earlier
wrapper launch was neither a product/runtime failure nor an accepted lifecycle
result.

Preflight stopped-state boundaries were:

| Boundary | Aggregate |
|---|---|
| `%APPDATA%\murmur` | Aggregate metadata recorded; content was not inspected. |
| `%APPDATA%\Eve` | Aggregate metadata recorded; content was not inspected. |
| Scoped startup state | All ten allowlisted Run/StartupApproved values absent |
| Shared caches | Presence recorded only; contents were not inspected. |
| Published baseline | Official `app.asar` SHA-256 `98910F5CD2C3A9426ECD7850EE352E47F9C48FB00BB5EEF526220660E69FC8FD` |

| Lifecycle boundary | Result |
|---|---|
| Candidate install | Set A installed through the frozen GUID as `Eve 0.6.3`; candidate `app.asar` matched; stopped aggregates and startup state were unchanged. |
| Runtime health | Owned server became healthy; version `0.6.3`; Faster-Whisper `large-v3-turbo` ready; CUDA and packaged CUDA DLLs available; zero warnings. |
| Controlled dictation | The repository WAV fixture was converted in memory only. Fast (10.0 s) and Long (47.334 s) produced non-empty finals with no errors; Long emitted `long_dictation_started` and `long_dictation_processing`. No transcript or audio was retained. |
| Singleton | A second Eve launch exited; the original main process and server remained; one main process remained. |
| Stopped preservation | Both profile aggregates were preserved; Eve metadata changes were owned runtime metadata only. |
| Same-version repair | Untouched, hash-verified Set B repaired through the explicit local payload. Candidate `app.asar`, frozen identity, stopped aggregates, and startup state remained exact. |
| Repaired health | The owned server became healthy and ready after the conservative poll boundary; version/CUDA/DLL checks passed with zero warnings. |
| Normal uninstall | Exit `0` in 0.851 s plus brief deferred cleanup; install root and frozen-GUID key were removed. Both profiles, all shared caches, and scoped startup state were preserved. |
| Published rollback | Checksum-verified official wrapper/payload restored `Murmur 0.6.3`, the frozen GUID, and official `app.asar`; fresh owned health was ready with CUDA/DLL checks passing and zero warnings. |
| Final restoration | All ten scoped startup values matched their pre-test absent state; official Murmur remained healthy. |

The official rollback artifacts were:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `Murmur.Web.Setup.0.6.3.exe` | 887,561 | `366088A4266F54EA7C39E2E7FD1FC7177CAC46BF8A4B3F43D58A6D025E15CD33` |
| `murmur-0.6.3-x64.nsis.7z` | 2,034,188,308 | `0B557FDE05853DA1F7C0AEF77CECBAD1FAF8C5FC9314457EA45119D3A69F4FBD` |

Restored official `app.asar` SHA-256 was
`98910F5CD2C3A9426ECD7850EE352E47F9C48FB00BB5EEF526220660E69FC8FD`.
The official main process and its owned server reported version `0.6.3`, ready `large-v3-turbo`, CUDA and CUDA DLLs
available, and zero warnings.

No personal profile content, transcript, audio output, unknown startup value, or
shared-cache file was inspected, recorded, or deleted. No installer, package,
manifest, log, screenshot, probe, helper, or downloaded artifact is committed.

## Final validation and hosted review

Local Gate A on 2026-07-28 passed:

| Check | Result |
|---|---|
| Focused Gate 5B resource/identity tests | 6 passed, 0 failed; 254 assertions |
| Deterministic derivative check | `build:icons -- --check` passed |
| Full application suite | 111 passed, 0 failed; 640 assertions |
| History/Insights aggregate guard | Passed |
| TypeScript | Main and renderer no-emit checks passed |
| Production build | Main, preloads, and renderer passed |
| Server suite | 139 passed, 0 failed; one existing Transformers cache deprecation warning |
| Version and lock checks | Version `0.6.3` and frozen `uv.lock` passed |
| Diff/scope/privacy | `git diff --check` passed; exactly 15 allowed files; no generated-output, dependency, lock, workflow, server-source, profile, cache, startup, release, or publication drift |
| Frozen references | Application `37A983FA4BA295347E4FEBB28DAB428570DFB997E27209A002BBF7E74806DC4C`; overlay `60CC848D4837BB83307C9F750D1DD3D9F6D83B364707780A363E86D971EDF742` |

The 2026-07-28 `bun audit` advisory feed reported 54 findings in the unchanged
dependency graph (1 critical, 39 high, 13 moderate, and 1 low), primarily in
transitive build tooling. Gate 5B changes no manifest version or lockfile, and
its frozen scope forbids unrelated dependency churn. This is recorded as the
current repository baseline for a separately scoped dependency-maintenance
follow-up, not represented as a Gate 5B regression or silently suppressed.

Hosted acceptance completed on 2026-07-28:

- PR `#20` reached Ready for review at accepted code/test head
  `c30fc663e549b29eddcacba2754036d247f3d9d2`.
- `Version Consistency`, `App Test And Build`, and `Server Tests` passed on that
  head.
- A real CodeRabbit review produced one actionable test finding. The package
  script's deterministic icon check is now executed by the regression test
  through the current Bun runtime; focused and full Gate A validation passed.
- The single review thread was answered and resolved, leaving zero unresolved
  threads. CodeRabbit's final status was successful.
- The pre-record worktree was clean and the PR contained exactly the 15 planned
  Gate 5B files. This evidence-only record does not alter the accepted packaged
  resources, application behavior, installer identity, or lifecycle result.
