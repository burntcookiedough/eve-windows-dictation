# Eve v0.8.2-alpha.7 release notes (candidate draft)

**Status:** Candidate notes only. Eve v0.8.2-alpha.7 has not been published; this is
not a release announcement.

This candidate continues the CPU-first Faster-Whisper and CTranslate2 runtime while
prioritizing security fixes and a verified in-place upgrade path.

## Candidate changes

- Debug diagnostics retain input and output lengths while omitting raw dictation input,
  recognized text, and output text.
- Malformed server-frame warnings retain the frame length rather than its contents.
- The optional NVIDIA GPU pack is bound to the alpha.7 app identity. It reuses the
  existing published pack with the same two files, URLs, sizes, hashes, and CTranslate2
  build identity; downloading and enabling CUDA remain opt-in.
- The dedicated Windows lifecycle gate covers the published alpha.5 baseline, a
  synthetic in-place upgrade to alpha.7, profile and model-cache sentinel retention,
  CPU transcription, and rollback on a disposable hosted runner.

## Compatibility and privacy

- Faster-Whisper through CTranslate2 remains the packaged model family. Model weights
  remain separate first-use downloads.
- Eve's app and installer identity, Eve and preserved Murmur profiles, internal
  `murmur` compatibility names, protocols, and install chain remain unchanged.
- Captured audio and transcripts remain local. Debug-mode logging records length
  metadata instead of raw content.

## Release status

These notes describe an unpublished candidate. Security review, exact-head PR review
and merge, a fresh package from the merged commit, hosted lifecycle validation, and a
laptop in-place upgrade with opaque profile checks remain required. No public app tag,
asset upload, or release is part of this candidate work. The published [Eve
v0.8.2-alpha.5 release](https://github.com/burntcookiedough/eve-windows-dictation/releases/tag/v0.8.2-alpha.5)
is the fixed baseline used by this candidate's hosted lifecycle gate.
