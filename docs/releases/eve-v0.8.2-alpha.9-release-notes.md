# Eve v0.8.2-alpha.9 release notes

**Channel:** Windows alpha pre-release candidate; not yet published.

The dictation overlay now uses a compact translucent pill with a voice-reactive
bead. It expands while speaking and collapses to a breathing dot during silence.
Startup, elapsed time, Long Dictation progress, completion word count and short
warnings appear inside the pill. The overlay transcript panel is removed; History
and transcription processing remain available. The timer is visible while expanded.

The overlay reasserts its topmost position without taking focus. Windows system
surfaces and exclusive fullscreen applications can still cover it.

The installer, profiles, protocols and model-cache identities are unchanged.
Runtime dependencies and optional GPU pack asset URLs and hashes are unchanged.
This candidate binds the existing optional GPU pack to alpha.9; reuse of an older
installed pack across app versions is not introduced. The unsigned `nsis-web`
installer needs internet access. Model weights and the optional NVIDIA pack are
separate downloads.

Automated tests and synthetic overlay checks do not establish real microphone
dictation acceptance or clean-machine installer lifecycle acceptance.
