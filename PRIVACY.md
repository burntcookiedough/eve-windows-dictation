# Privacy boundaries

The default packaged configuration performs speech recognition on the user's machine. Microphone audio travels from the Electron renderer through the main process to the packaged Python service over a WebSocket on that machine. Final transcripts and derived History/Insights data are stored locally.

## Network access

Network access is still required in these cases:

- the NSIS web installer downloads the application payload from GitHub Releases;
- an engine downloads its model files from Hugging Face on first use;
- a developer or user deliberately configures external-server mode.

External-server mode changes the trust boundary because captured audio is sent to the configured server URL. Users are responsible for the operator and privacy terms of that endpoint.

## Local data

The current v0.6.3 binary uses Electron's Murmur user-data directory, including `%APPDATA%\murmur` on a standard Windows installation. It stores settings and a SQLite transcription History there. Model files use the relevant Hugging Face cache location.

Repository and product naming work does not authorize moving or deleting these locations. A future Eve application-identity migration must preserve History, settings, and model caches, support rollback, and avoid duplicate downloads where practical.

## Diagnostics and contributions

The in-app diagnostics copy feature is designed around an allowlisted summary and excludes logs, paths, History, and transcription text. Users should still review any report before sharing it.

Do not add telemetry or analytics without a separate privacy review, explicit documentation, and user-visible controls. Test fixtures, screenshots, crash reports, and pull requests must not contain private dictated text, audio, clipboard data, tokens, device labels, or unredacted paths.
