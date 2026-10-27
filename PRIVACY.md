# Privacy boundaries

The default packaged configuration performs speech recognition on the user's machine. Microphone audio travels from the Electron renderer through the main process to the packaged Python service over a WebSocket on that machine. Final transcripts and derived History/Insights data are stored locally.

## Network access

Network access is still required in these cases:

- the NSIS web installer downloads the application payload from GitHub Releases;
- an engine downloads its model files from Hugging Face on first use;
- a user explicitly installs optional NVIDIA GPU support from Eve's versioned GitHub Release assets;
- a developer runs a separately started localhost speech service during development.

Packaged Eve keeps speech processing on its bundled local service. The optional GPU download sends no audio or transcripts. Eve does not expose a configurable external-server endpoint.

## Local data

Current Eve builds use a separate Electron profile, normally `%APPDATA%\Eve` on Windows. It contains app settings, persisted server settings (`server-settings.json`), and the SQLite transcription History/Insights database (`history.db`). Model files use the relevant Hugging Face cache location. Optional GPU support files normally live under `%LOCALAPPDATA%\Eve\gpu-packs`, separately from the profile's speech data.

The historical Murmur v0.6.3 release uses its own profile, normally `%APPDATA%\murmur`. Eve does not import that profile's History, settings, hotwords, browser storage, credentials, or external-server configuration. Naming changes do not authorize moving or deleting legacy data. Shared third-party model caches may be reused without reading Murmur userData.

Developer data-reset tools have narrower scopes than the whole profile. See [local data and reset scope](docs/development/building.md#local-data-and-reset-scope) before resetting settings or History. The [historical Murmur setup guide](docs/windows-local-cuda-dictation.md) retains its original paths as release evidence.

## Diagnostics and contributions

The in-app diagnostics copy feature is designed around an allowlisted summary and excludes logs, paths, History, and transcription text. Users should still review any report before sharing it.

Do not add telemetry or analytics without a separate privacy review, explicit documentation, and user-visible controls. Test fixtures, screenshots, crash reports, and pull requests must not contain private dictated text, audio, clipboard data, tokens, device labels, or unredacted paths.
