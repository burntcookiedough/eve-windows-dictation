# AGENTS.md

Eve is a Windows dictation app: Electron/Svelte/Bun in `app/`, and a Python
FastAPI/WebSocket service in `server/`. Read the relevant docs before changes.

## Windows safety

- Run `bun`, `uv`, Python tests, dependency changes, builds, and packaging only
  from Windows PowerShell. Never create Linux/WSL `.venv` or `node_modules`.
- Use the current clone path; do not copy environments or depend on user paths.
- For app work: `Set-Location app; bun run <script>`.
- For server work: `Set-Location server; uv sync --extra whisper --group dev --frozen; uv run pytest`.
- Use `uv sync --python 3.11 --no-dev --extra release --frozen` for release-runtime
  preparation. The `nemotron` extra remains available for deferred repair work
  and is not part of the shipped alpha.

## Product and privacy boundaries

- Default processing is local; an external server is an explicit user choice.
- Never commit or inspect private audio, transcripts, clipboard data, tokens,
  personal profiles, caches, or unredacted user paths.
- Preserve frozen Eve identity and Murmur compatibility: appId, NSIS GUID,
  profiles, protocols, environment names, install chain, runtime, and cache
  behavior. Do not rename internal Murmur identifiers without an approved migration.

## Release boundaries

- `nsis-web` is the supported installer. Do not alter released assets or hashes.
- Packaging, signing, installer, runtime, identity, and release work require the
  applicable release plan and explicit authorization. Do not tag, upload, or publish
  without it.
- Keep versions and locks unchanged unless the task explicitly authorizes them;
  verify with `python scripts/version.py check --tag v0.8.0` when relevant.

## Workflow

- Keep changes focused; preserve existing user changes and do not rewrite history.
- Run the smallest relevant tests, then required full checks. Review `git diff --check`.
- Extended collaboration and validation guidance: [agent workflow](docs/development/agent-workflow.md).

## Commit attribution

- Use the documented attribution byline for the active agent and never invent or impersonate an identity.
