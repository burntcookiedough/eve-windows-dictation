# Eve v0.8.2-alpha.6 release notes (candidate draft)

**Status:** Candidate notes only. Eve v0.8.2-alpha.6 has not been published; this document is not a release announcement.

Eve v0.8.2-alpha.6 focuses on usable CPU-first installs and a leaner packaged runtime while retaining the Faster-Whisper and CTranslate2 transcription path.

## Highlights

- New packaged Windows profiles start with the **Small** model for CPU use. Existing profiles, saved model choices, and explicit environment overrides keep their current behavior.
- The packaged base runtime removes PyTorch and the full CUDA runtime closure. Model weights remain separate downloads and are not embedded in the installer.
- Eve checks that a packaged server matches the expected application build and runtime before adopting it. Unsupported GPU or precision preferences fall back to a compatible CPU configuration; explicitly selecting unavailable CUDA settings is rejected.
- Settings report optional NVIDIA pack availability. The production GPU-pack descriptor remains unset in this candidate, so Eve cannot download or activate a GPU pack.
- Server start, stop, and restart handling is more reliable when requests overlap. Environment-only model choices are not written into saved settings by unrelated settings updates.

## Compatibility and privacy

- Faster-Whisper through CTranslate2 remains the only packaged model family. Model weights are downloaded separately on first use.
- New-profile defaults do not replace model choices or other settings in existing Eve profiles. The preserved Murmur profile, Eve identity, protocols, and install compatibility remain unchanged.
- Model weights remain separate first-use downloads, while audio and transcripts stay local.

## Release status

This is a draft for an unsigned Windows prerelease. Packaging, clean-install and runtime verification, lifecycle checks, manifest verification, and protected promotion remain release gates. Until alpha.6 is published, [Eve v0.8.2-alpha.5](https://github.com/burntcookiedough/eve-windows-dictation/releases/tag/v0.8.2-alpha.5) remains the latest published prerelease.
