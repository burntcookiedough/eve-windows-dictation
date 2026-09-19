# Eve v0.8.2-alpha.5 release notes

Eve v0.8.2-alpha.5 adds a focused History export workflow on top of the Faster-Whisper-only
runtime cleanup from alpha.4.

## Highlights

- Exports completed History entries as JSON or CSV through the native Windows save dialog.
- Exports either all completed entries or only the selected entries, with selection respecting
  the current History filters.
- Keeps export ordering deterministic, preserves the existing History selection and delete
  controls, and writes files atomically so a failed export does not replace an existing file.
- Includes bounded input validation and spreadsheet-formula protection for CSV output.

## Compatibility and privacy

- Export is local to Eve and only writes the entries the user explicitly chooses; it does not
  upload transcripts, inspect unrelated files, or change the active `%APPDATA%\\Eve` profile.
- Eve continues to use the bundled Faster-Whisper runtime, the existing shared model cache,
  and the frozen Eve/Murmur install, profile, protocol, and compatibility names.
- Existing legacy `%APPDATA%\\murmur` data remains untouched, and no model, database schema,
  or dependency migration is included.

## Release status

This is an unsigned Windows prerelease. Windows may show an Unknown Publisher warning and
Microsoft Defender SmartScreen may require an explicit user decision before installation.
Publication remains conditional on the exact-head package, installer/runtime verification,
asset manifest verification, and protected prerelease promotion gates. No release asset or
historical alpha.4 evidence is replaced by this preparation.
