# Contributing

Eve targets Windows and combines an Electron/Svelte client with a Python transcription service. Keep changes narrow enough to review and verify as one behavior change.

Before contributing:

1. Read [AGENTS.md](../AGENTS.md) and [the build guide](../docs/development/building.md).
2. Use Windows PowerShell for Bun, uv, Python, pytest, dependency, and build commands. Do not create Linux dependencies in a Windows worktree.
3. Preserve `%APPDATA%\murmur`, model caches, History, settings, and existing installer identity unless a migration proposal has been approved separately.
4. Do not include transcripts, audio, clipboard contents, tokens, private paths, or raw environment dumps in logs, fixtures, screenshots, or bug reports.

## Pull requests

- Start from current `trunk` and explain the user-visible problem or engineering failure.
- Separate observed behavior from hypotheses.
- Include focused regression coverage and the exact validation commands you ran.
- Avoid dependency or lockfile churn unrelated to the change.
- Treat benchmark results as reproducible measurements: record hardware, operating system, engine and model versions, decoding settings, audio set, sample count, and date.
- Label future-engine, component-pack, and visual concepts as research until they pass packaged Windows acceptance.

The project does not currently promise review or support response times. A draft pull request is the clearest way to propose a source change while public issue tracking remains closed.
