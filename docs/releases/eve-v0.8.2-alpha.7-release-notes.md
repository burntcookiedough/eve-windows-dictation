# Eve v0.8.2-alpha.7 release notes

**Channel:** Windows alpha pre-release.

## Highlights

- A compact monochrome interface brings Home, History, Insights, and Settings into a
  consistent layout. Settings uses an accessible language dropdown and groups server
  health, diagnostics, and logs under Engine.
- The fixed 2:3 main window fits the available monitor work area and is repositioned
  when display layouts change. History deletion supports Undo, flushes on pagehide,
  and waits for pending database writes before app exit.
- The packaged speech service rejects non-loopback peers, browser-originated requests,
  and invalid or non-local Host headers. It bounds partial-emission settings and closes
  sessions when no first audio frame arrives.
- Debug logs keep length metadata while omitting dictated input and recognized text.
  Clipboard copy, paste, and restore use Electron's asynchronous API.
- The CPU-first Faster-Whisper runtime uses maintained CPython 3.11.17 and
  CTranslate2 4.6.3. Model weights remain first-use downloads; the optional NVIDIA
  pack reuses its existing assets and build identity and remains opt-in.

Eve's app and installer identity and its Eve and preserved Murmur profiles remain
unchanged. Hosted Windows lifecycle checks passed the synthetic upgrade, CPU
transcription, and rollback path. Captured audio and transcripts stay on the device.
See the [v0.8.2-alpha.7 release page](https://github.com/burntcookiedough/eve-windows-dictation/releases/tag/v0.8.2-alpha.7)
for current downloads and release status.
