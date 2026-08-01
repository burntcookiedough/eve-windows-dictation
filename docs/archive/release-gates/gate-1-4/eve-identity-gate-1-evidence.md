# Eve identity Gate 1 evidence

## Purpose

This record supports the compatibility-scaffolding gate in [ADR-001](../../../architecture/adr-001-eve-application-identity-migration.md). It does not authorize the Eve data-path or visible-product cutover.

## Published v0.6.3 assets

The preserved files were matched byte-for-byte to the GitHub v0.6.3 release metadata on 2026-07-21.

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `latest.yml` | 564 | `b211cdb0322a0f6da01eee77921f6c6961735de59d4ffd8cacc31d9a3f7395a9` |
| `murmur-0.6.3-x64.nsis.7z` | 2,034,188,308 | `0b557fde05853da1f7c0aef77cecbad1faf8c5fc9314457ea45119d3a69f4fbd` |
| `Murmur.Web.Setup.0.6.3.exe` | 887,561 | `366088a4266f54ea7c39e2e7fd1fc7177cac46bf8a4b3f43d58a6d025e15cd33` |

The published update manifest identifies version `0.6.3`, the same x64 package size and digest, and the historical Murmur artifact names. Historical assets remain immutable.

## Installer identity derivation

Published v0.6.3 uses:

```text
appId: com.murmur.app
target: nsis-web
electron-builder declaration: ^26.4.0
electron-builder resolved version: 26.15.3
explicit NSIS GUID: absent
```

The resolved Electron Builder 26.15.3 implementation derives the default NSIS GUID as UUID v5 of the application ID under namespace `50e065bc-3134-11e6-9bab-38c9862bdaf3`:

```text
UUIDv5("com.murmur.app", "50e065bc-3134-11e6-9bab-38c9862bdaf3")
= 0204d005-75b3-5b31-b1f6-ef2831e2b204
```

That result exactly matches the observed HKCU uninstall key for the installed Murmur 0.6.2 build. Gate 1 freezes this value explicitly under `build.nsisWeb.guid`; it does not change the upgrade identity.

The target-specific configuration also pins the existing Electron Builder defaults:

```text
oneClick: true
deleteAppDataOnUninstall: false
```

## Host acceptance

Windows Sandbox failed at the host/VM connection layer with `0x80072746`, before it produced an installer result. After reviewing that limitation, the project explicitly approved an equivalent test on the Windows host. The test did not inspect personal data contents.

The candidate was built from commit `c613ed88b8de2c5e6d59fc7cbe024957f81ee2c3` with the complete published v0.6.3 Python and engine closure:

| Candidate asset | Bytes | SHA-256 |
|---|---:|---|
| `Murmur Web Setup 0.6.3.exe` | 887,564 | `47df9c7726c7b14cc878790d74ad0a1ffc98654358697287af4437744e70f7f3` |
| `murmur-0.6.3-x64.nsis.7z` | 2,034,067,298 | `c9811cb6e5c195d63bf86063d6f80ba22b542d6c7d5b8ee4fd38efa4b392f920` |
| packaged `app.asar` | 11,157,398 | `4619cfeb93633106cc37b181906440c527b0ce770092fe1282aa365d96b69dc2` |

The candidate payload was 115,697 bytes smaller than the published payload. Its unpacked server closure contained PyTorch, NeMo, CTranslate2, and faster-whisper.

The following matrix passed on 2026-07-22:

| Check | Evidence |
|---|---|
| Published baseline install | Published v0.6.3 installed as `Murmur 0.6.3` under uninstall key `0204d005-75b3-5b31-b1f6-ef2831e2b204`; application launch and dictation worked. |
| Candidate repair/upgrade | Installing the same-version candidate replaced the installed `app.asar` with the candidate SHA-256 above while retaining the same display version and uninstall key. |
| User-data preservation | `%APPDATA%\murmur` existed before and after candidate installation and uninstall. Contents were not inspected. |
| Runtime behavior | Fast Dictation, Long Dictation, normal launch, and restart were manually accepted. |
| Single-instance behavior | A second launch exited within ten seconds; the original five Electron processes remained responsive and the process count did not increase. |
| Candidate uninstall | Registered silent current-user uninstall exited `0`, removed the program directory and uninstall key, and retained `%APPDATA%\murmur`. |
| Stable restoration | The checksum-verified published installer restored v0.6.3. Installed `app.asar` SHA-256 returned to `98910f5cd2c3a9426ecd7850ee352e47f9c48fb00bb5eef526220660e69fc8fd`, and the application launched responsively. |

This is proportionate evidence for the compatibility-only Gate 1 change. It is not clean-VM acceptance and does not authorize the later Eve visible-identity or data-root cutovers; those remain separately gated.

## Privacy boundary

The acceptance run read release metadata, installer fingerprints, executable metadata, process state, and Windows uninstall metadata. It installed and uninstalled Murmur only after explicit approval. It did not read Murmur History, settings, hotwords, browser storage, credentials, logs, or diagnostic contents; delete either user-data root; or create Eve data.
