# Contributing

Eve targets Windows and combines an Electron/Svelte client with a Python transcription service. Keep changes narrow enough to review and verify as one behavior change.

Before contributing:

1. Read [AGENTS.md](../AGENTS.md) and [the build guide](../docs/development/building.md).
2. Use Windows PowerShell for Bun, uv, Python, pytest, dependency, and build commands. Do not create Linux dependencies in a Windows worktree.
3. Preserve the active `%APPDATA%\Eve` profile, legacy `%APPDATA%\murmur`, model caches, History, settings, and existing installer identity unless a migration proposal has been approved separately.
4. Do not include transcripts, audio, clipboard contents, tokens, private paths, or raw environment dumps in logs, fixtures, screenshots, or bug reports.

## Local hooks

In Windows PowerShell, run `powershell -NoProfile -File scripts/install-hooks.ps1`
from the repository root. This sets `core.hooksPath` for the repository, including
its linked worktrees. The pre-commit hook checks staged whitespace and rejects
audio files, `.env*` files other than `.env.example` and `.env.sample`,
transcript JSON/JSONL, and files under `profiles/` or `user-data/`.
Use `git commit --no-verify` as a deliberate override after reviewing the
staged changes, such as when updating the tracked fixture
`server/tests/ui/test_audio.wav`.

Claude Code uses the project hook in `.claude/settings.json` when Node is on
`PATH`. It blocks direct shell commands for protected Git and release operations.

## Issues and pull requests

- Report bugs or suggest changes through GitHub Issues.
- Security-sensitive reports must follow [SECURITY.md](SECURITY.md), not public issues or pull requests.
- Start pull requests from current `trunk` and explain the user-visible problem or engineering failure.
- Separate observed behavior from hypotheses.
- Include focused regression coverage and the exact validation commands you ran.
- Avoid dependency or lockfile churn unrelated to the change.
- Treat benchmark results as reproducible measurements: record hardware, operating system, engine and model versions, decoding settings, audio set, sample count, and date.
- Label future-engine, component-pack, and visual concepts as research until they pass packaged Windows acceptance.

The project does not currently promise review or support response times.
