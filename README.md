# Eve for Windows

<p><img src="https://img.shields.io/badge/v0.8.2-alpha.1-orange?style=flat-square" alt="v0.8.2-alpha.1"> <strong>Source status: v0.8.1 pre-alpha · unreleased</strong></p>

## Local-first dictation that stays in your flow

Eve is a Windows desktop dictation app for turning speech into usable text quickly. Hold a global hotkey, speak into a calm click-through overlay, then keep working: your text can go to the clipboard, local History, or Insights without leaving the app.

![Eve workspace showing History, Insights, and Settings](docs/architecture/assets/eve-gate-5-application-reference.png)

![Eve recording overlay states](docs/architecture/assets/eve-gate-5-overlay-reference.png)

### The everyday workflow

1. Press the dictation hotkey and speak.
2. Watch the overlay show microphone levels, partial text, and long-dictation state.
3. Stop when you are done. Eve can copy the result, paste it into the active app, and keep a searchable local record.

## Built for real work

- Fast Dictation and Long Dictation modes with a global hotkey.
- A click-through overlay that keeps recording state visible without taking focus.
- Automatic clipboard copy and paste, with optional clipboard restoration.
- Searchable local History and aggregate Insights.
- A packaged Python transcription service with CPU fallback and CUDA diagnostics for supported NVIDIA systems.
- Privacy-bounded diagnostics and explicit server controls.

The desktop client captures 16 kHz mono audio and sends it over a local WebSocket to the packaged Python service. The service returns partial and final text for the overlay, clipboard, and local History.

## Choose your model

Models are downloaded from their public Hugging Face repositories the first time you use them; they are not embedded in the installer. The catalog below reflects the built-in choices exposed by Eve.

| Choice | Best for | Engine and model |
| --- | --- | --- |
| **Large V3 Turbo — Recommended Multilingual** | A balanced everyday multilingual option | [faster-whisper-large-v3-turbo](https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo) |
| **Large V3 — Maximum Multilingual Accuracy** | Quality-first multilingual work | [faster-whisper-large-v3](https://huggingface.co/Systran/faster-whisper-large-v3) |
| **Small — Lightweight** | A smaller download for constrained hardware | [faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) |
| **Medium / Tiny — Advanced** | Raw engine choices for users who want to tune the trade-off | [faster-whisper-medium](https://huggingface.co/Systran/faster-whisper-medium) / [faster-whisper-tiny](https://huggingface.co/Systran/faster-whisper-tiny) |

The v0.8.1 alpha ships Faster-Whisper as its sole selectable engine. Nemotron
remains in the source tree and optional `nemotron` dependency for deferred
repair work; it is not shipped or user-selectable in this alpha.

Eve derives device and precision availability from the installed PyTorch and CTranslate2 runtimes. `auto` is the safest starting point; a particular device/precision/model combination still depends on the local driver, VRAM, and runtime capabilities. The catalog is not a promise of every device-by-precision combination.

## Local-first, with clear network boundaries

The default packaged path keeps captured audio and transcription on the local machine. Network access is used for the small installer to fetch its application payload and for the selected model's first-use download from Hugging Face. External-server mode is an explicit choice: when enabled, audio is sent to the server URL configured by the user rather than the packaged local service.

Read the full data boundary in [PRIVACY.md](PRIVACY.md). Do not include private audio, transcript text, clipboard contents, access tokens, or unredacted local paths in support or security reports; see [support](.github/SUPPORT.md) and [SECURITY.md](.github/SECURITY.md).

## Installation and release status

The current public release is **Eve v0.7.0**. [Download Eve v0.7.0](https://github.com/burntcookiedough/eve-windows-dictation/releases/tag/v0.7.0). It is published and available from GitHub. The `nsis-web` installer downloads the application payload during installation, and internet access is required again if an engine needs its model. The release is unsigned and may trigger Windows reputation warnings.

### v0.7.0 integrity evidence

The [v0.7.0 release record](https://github.com/burntcookiedough/eve-windows-dictation/releases/tag/v0.7.0) lists these uploaded assets. SHA-256 values are integrity evidence; GitHub release metadata is not treated as immutable.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `Eve.Web.Setup.0.7.0.exe` | 654,555 | `e27646c15be0563c45e35b34b157105af2a61424ef1bff6cf8a9c72f8a763e4a` |
| `murmur-0.7.0-x64.nsis.7z` | 2,033,658,084 | `9f3137a096ac2183828e393a41b19e23a0b7387c2f44d40f6285d059ae2ae619` |
| `latest.yml` | 558 | `fd23678bbed97980152fe9495c27f39081e61c1207f76f0eb614afac9d5c6221` |

The current source tree also contains **Eve v0.8.1 pre-alpha work**. It is unreleased source work, not a published version or downloadable artifact; use the [development setup](#development) below to run it locally.

## Development

Development and packaging target Windows. If you open the repository from WSL, run Bun, uv, Python, pytest, and packaging commands through Windows PowerShell so platform-specific environments are not replaced with Linux binaries.

The supported Windows installer packaging target is `nsis-web`; packaging remains a release-authorized step.

```powershell
# Server
cd server
uv sync --extra whisper --group dev
uv run pytest

# Desktop app, in a separate PowerShell session
cd app
bun install
bun run dev
```

Use `uv sync --extra release --frozen` when preparing the Whisper-only shipped alpha runtime. See [the Windows build guide](docs/development/building.md), [docs/protocol.md](docs/protocol.md), and [contributing](.github/CONTRIBUTING.md).

## Compatibility and provenance

Eve preserves the upgrade boundaries established by its Windows history: the visible Eve product and profile, frozen installer identity, internal `murmur` package name, compatibility payload name, and `MURMUR_*` interfaces remain stable. Eve uses a separate `%APPDATA%\Eve` profile and does not automatically import or delete Murmur History, settings, or other personal state. Historical Murmur v0.6.3 assets remain immutable.

The [v0.6.3 engineering case study](docs/archive/engineering/v0.6.3-release-case-study.md) records the release-hardening work behind the current Windows path. The [roadmap](docs/project/roadmap.md) separates research and planned component downloads from shipped functionality.

## License

The source is available under the [MIT License](LICENSE). Eve contains software derived from the MIT-licensed Murmur project; original copyright notices and commit authorship are preserved. See [NOTICE.md](NOTICE.md).
