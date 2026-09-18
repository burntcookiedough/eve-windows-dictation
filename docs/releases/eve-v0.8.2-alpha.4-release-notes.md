# Eve v0.8.2-alpha.4 release notes

Eve v0.8.2-alpha.4 is a focused model-runtime cleanup prerelease.

## Highlights

- Narrows the supported transcription runtime to Faster-Whisper and removes the retired
  Nemotron implementation, dependencies, settings, UI paths, and proof-of-concept assets.
- Introduces a dedicated Faster-Whisper adapter behind an explicit model-runtime contract,
  leaving a reviewed seam for future model families without carrying unused providers.
- Keeps a bounded legacy-settings migration so existing Eve installations retain valid
  Whisper choices while unsupported Nemotron values are discarded safely.
- Uses a server-owned model catalog and candidate-specific preparation status so the app
  reports the model actually being prepared instead of stale download state.
- Reduces the tracked source tree substantially while retaining the existing Eve/Murmur
  install chain, profiles, local-processing boundary, and shared model cache.

## Compatibility and release status

Eve continues to process audio through its bundled local service. It does not
automatically import or delete personal data from the legacy Murmur profile. The
AppUserModelID, frozen NSIS GUID, `nsis-web` installer chain, active `%APPDATA%\Eve`
profile, preserved `%APPDATA%\murmur` profile, and internal compatibility names remain
unchanged.

This Windows alpha is intentionally unsigned, so Windows may show a security warning.
The web installer payload is large, and selected speech-model weights may require a
separate first-use download. Only artifacts attached to the matching GitHub prerelease
have passed the exact-head package, lifecycle, manifest, and promotion gates.
