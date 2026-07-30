# Eve v0.8.0 release notes

Status: release preparation only. Eve v0.8.0 is not published and no release artifact is
created by these notes.

## Highlights

- The transcript overlay keeps a fixed two-line viewport while retaining full accessible
  transcript text and following the newest line as partial dictation arrives.
- Home is the default view and presents read-only server and model readiness, current
  shortcuts, dictation guidance, privacy information, and links to the rest of Eve.
- Model/server status is shared by the renderer so Home, banners, and settings describe
  the same connection, preparation, download, and error state without duplicate polling.
- Speech model settings provide four curated choices over existing bundled engines:
  English Performance, Recommended Multilingual, Maximum Multilingual Accuracy, and
  Lightweight. Selecting a choice does not start work; **Apply and prepare model** is the
  explicit action that may prepare its separately downloaded model weights.
- Downloads remain resumable. Before a missing or partial selected model download begins,
  Eve checks available space on the existing Hugging Face cache filesystem without moving,
  deleting, or inventorying unrelated cached data.

## Compatibility and privacy

- Eve processes audio locally by default. If a user configures an external endpoint, audio
  is sent to that endpoint under the user's control.
- Eve does not automatically read, import, merge, prompt for, or delete legacy Murmur
  personal data. `%APPDATA%\murmur` remains untouched; `%APPDATA%\Eve` is the active
  profile.
- The Eve app identity, frozen NSIS GUID, `nsis-web` installer chain, shared model-cache
  location, and internal Murmur package/runtime/protocol/environment compatibility names
  remain unchanged.

## Before publication

This is a source-release-preparation record, not a public download announcement. A
separately authorized exact-head package, Windows lifecycle validation, release artifact
audit, and publication decision are still required. No updater, signing, thin-client,
single-file installer, or public release-asset cleanup is included in v0.8.0.
