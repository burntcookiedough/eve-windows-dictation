# Eve identity Gate 1 evidence

## Purpose

This record supports the compatibility-scaffolding gate in [ADR-001](adr-001-eve-application-identity-migration.md). It does not authorize the Eve data-path or visible-product cutover.

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

## Acceptance still pending

No Windows Sandbox, Hyper-V VM, VirtualBox, or VMware runner was available on the inspection machine. Therefore these claims remain deliberately unmade:

- a clean published v0.6.3 installation was observed writing the derived key;
- install-over-v0.6.3, repair, and uninstall behavior passed on a clean VM;
- the nsis-web uninstaller was observed preserving controlled Eve and Murmur data fixtures.

This compatibility-scaffolding change must remain unmerged until the clean-VM identity check is completed, or the project explicitly approves equivalent isolated evidence. The later visible Eve and data-root cutovers remain separately gated regardless.

## Privacy boundary

The inspection read release metadata and Windows uninstall metadata only. It did not read Murmur History, settings, hotwords, browser storage, credentials, logs, or diagnostic contents. It did not install or uninstall Murmur, write registry values, create Eve data, or modify either user-data root.
