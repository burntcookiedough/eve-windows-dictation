# Eve v0.8.2-alpha.8 release notes

**Channel:** Windows alpha pre-release.

Long Dictation now keeps at most 4 MiB of PCM in its in-memory store before
spooling to a local temporary file. Final transcription reads bounded chunks,
preserving sample order, quiet boundaries, overlap, progress and timing without
converting the whole recording at once. Short recordings stay in memory.

Backing audio is removed on completion, cancellation, disconnect and errors.
Windows delete-on-close also removes it when the speech-server process terminates.
This is temporary file deletion, not a secure-erasure guarantee across power loss.
Audio is not added to History or logs; History continues to store recognized text.

Transcription threshold and chunk settings now enforce their existing advertised
maximums of 120 and 60 seconds. Older larger values are clamped while preserving
unrelated settings. Background-task errors also release the model session lease.

Synthetic two-hour input tests verify bounded allocations and ordered final
samples. These are accelerated data-volume tests with model-free inference, not a
two-hour live microphone or Whisper accuracy test.

The app, installer, profile, protocol and model-cache identities remain unchanged.
Runtime and dependency versions are unchanged from alpha.7. The optional GPU pack
is pinned to alpha.8 using the same native assets, URLs and hashes; cross-version
reuse of an existing local GPU pack remains outside this change. The unsigned
`nsis-web` installer needs internet access; model weights and the opt-in NVIDIA
pack remain separate downloads.

See [GitHub Releases](https://github.com/burntcookiedough/eve-windows-dictation/releases)
for release status and downloads.
