# Eve v0.9.0-beta.1 release notes

**Channel** — Windows beta candidate, awaiting release acceptance.

- Long Dictation transcribes during recording so that stopping only decodes the
  remaining audio.
- Eve reports whether dictation was pasted, copied, or could not be delivered,
  and surfaces History save failures.
- Compatible optional NVIDIA packs can be reused across Eve upgrades.

The supported Windows download is the internet-connected, unsigned `nsis-web`
installer. Windows SmartScreen may ask for confirmation. Model weights and the
optional NVIDIA pack are separate downloads. A download link will be added after
promotion.

## Acceptance

Local Windows validation passed the server suite, app suite, History Insights
check, app typecheck, and exact-tag version check. The app suite skipped one
clipboard test reserved for disposable hosted Windows.

Hosted installer lifecycle, packaged History on the same installer bytes, and
physical microphone, editor insertion, and GPU trials are pending. The
[release plan](../architecture/eve-beta1-release-plan.md) tracks these gates.
