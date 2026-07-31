# AGENTS.md

## Purpose

This repository uses a two-agent development workflow to conserve limited Codex usage while retaining strong planning, diagnosis, and review quality.

- **Codex** is the coordinating agent. It owns repository understanding, task decomposition, architecture, difficult diagnosis, implementation contracts, review, and final verification.
- **Antigravity CLI** is the implementation agent. It performs bounded code changes, test writing, routine debugging, repetitive iteration, and documentation work from a written task contract.
- The preferred Antigravity model is **Gemini 3.6 Flash**. If the installed Antigravity version exposes a different exact model identifier, select the newest available Gemini 3.6 Flash variant and record the selected identifier in the handoff report.

This file is authoritative for agents operating in this repository.

## Project context

Eve is a local Windows dictation application composed of:

- an Electron desktop application;
- Svelte, TypeScript, Vite, and Bun;
- native Node dependencies, including `better-sqlite3` and `uiohook-napi`;
- a packaged Python 3.11+ FastAPI/WebSocket transcription service;
- faster-whisper and optional NeMo/Nemotron ASR engines;
- local SQLite history and insights;
- Windows PowerShell build and release tooling;
- an NSIS-web installer with a packaged Python runtime.

The desktop client captures 16 kHz mono PCM audio, forwards it through the Electron main process to the local Python WebSocket service, receives partial and final transcripts, and coordinates overlay state, clipboard insertion, and local history.

Changes must preserve the following boundaries:

1. Default transcription remains local.
2. External-server mode remains an explicit user-selected exception.
3. No private audio, transcript, clipboard content, token, or unredacted local path may be added to diagnostics.
4. Historical Murmur compatibility identifiers must not be renamed casually.
5. Windows packaging behavior must be tested separately from development behavior.
6. Protocol, lifecycle, and session changes require regression tests.

## Agent roles

### Codex: coordinator and reviewer

Codex should:

1. Read this file before modifying the repository.
2. Inspect the relevant code and documentation.
3. Determine whether the task is mechanical, bounded, ambiguous, cross-layer, or release-critical.
4. Create a written task contract before handing implementation to Antigravity.
5. Start Antigravity only when the task is sufficiently bounded.
6. Review Antigravity's diff rather than trusting its completion summary.
7. Run or independently verify all required checks.
8. Take over directly when the task requires deeper repository understanding, architecture, concurrency diagnosis, security judgment, or release engineering.

Codex must not delegate responsibility for correctness. Delegation transfers implementation work, not ownership of the result.

### Antigravity CLI: bounded implementation agent

Antigravity should:

1. Read this file and the task contract.
2. Modify only the allowed files.
3. Preserve all listed invariants.
4. Run the specified validation commands.
5. Stop instead of inventing a workaround when the contract conflicts with the repository.
6. Produce a machine-readable handoff report.
7. Avoid broad refactors, dependency upgrades, architecture changes, or unrelated cleanup unless explicitly authorized.

Antigravity must not merge, publish a release, rewrite Git history, delete user data, or modify secrets.

## Model routing

Use the cheapest model that can reliably complete the task.

| Work | Preferred agent/model |
|---|---|
| Routine implementation, tests, repetitive fixes, documentation | Antigravity CLI / Gemini 3.6 Flash |
| Task contract creation and ordinary review | Codex / GPT-5.6 Luna xhigh |
| Difficult but bounded implementation | Codex / GPT-5.6 Luna max |
| Implementation that repeatedly defeats Luna | Codex / GPT-5.6 Terra max |
| Ambiguous cross-layer bugs and architecture | Codex / GPT-5.6 Sol medium or high |
| Release-critical investigation or stubborn failure | Codex / GPT-5.6 Sol high or max |

Do not use Sol for boilerplate, formatting, routine tests, or obvious local edits.

## Antigravity CLI setup

Codex should check whether Antigravity is available before delegating:

```powershell
Get-Command agy -ErrorAction SilentlyContinue
agy --version
```

If `agy` is unavailable, Codex should not fabricate installation commands. It should:

1. inspect the currently installed Google/Antigravity tooling and package managers;
2. consult the official Antigravity CLI installation instructions available in the environment;
3. install only with the user's existing authenticated subscription and normal user-level permissions;
4. verify the executable with `agy --version`;
5. verify authentication and model availability using the CLI's own help, model, quota, or usage commands;
6. avoid placing credentials in the repository, shell history, task files, or logs.

After installation, Codex should inspect the CLI rather than assume flags:

```powershell
agy --help
agy models --help
agy run --help
```

Command names may vary by Antigravity version. Use the installed CLI's help output as the source of truth.

Select Gemini 3.6 Flash using the exact identifier exposed by the installed CLI. Do not hard-code an unverified model slug into repository scripts.

## No native agent-to-agent channel

Codex and Antigravity do not share a reliable native conversation channel. Coordination occurs through:

- Git worktrees or isolated branches;
- task-contract Markdown files;
- Git diffs and commits;
- validation logs;
- structured handoff reports.

Codex may launch Antigravity from its terminal, but it must still treat Antigravity as an external process and independently inspect all resulting changes.

## Required workspace isolation

Do not let Codex and Antigravity edit the same working tree concurrently.

From the main repository:

```powershell
git fetch
git switch trunk
git pull --ff-only

$Task = "session-lifecycle"
$Branch = "ag/$Task"
$Worktree = "../eve-antigravity-$Task"

git worktree add $Worktree -b $Branch trunk
```

Run Antigravity inside the new worktree:

```powershell
Set-Location $Worktree
agy
```

If a branch or worktree already exists, inspect it instead of force-deleting it.

## Task-contract directory

All delegated tasks should use:

```text
docs/agent-tasks/<task-id>/
```

Each task directory contains:

```text
contract.md
handoff.json
validation.log
```

Optional files:

```text
notes.md
failure-report.md
screenshots/
artifacts/
```

Do not store secrets, private transcript content, audio, clipboard content, or unredacted machine paths in these files.

## Task contract

Codex must write `contract.md` before delegation.

Use this template:

```markdown
# Task: <concise title>

## Task ID
<kebab-case-id>

## Goal
<observable end state>

## Current behavior
<reproduction and evidence>

## Required behavior
<precise expected behavior>

## Scope
### Allowed files
- `path/to/file`

### Allowed supporting files
- tests directly required for this change
- task handoff files under this task directory

### Forbidden changes
- dependency upgrades unless explicitly listed
- protocol changes unless explicitly listed
- broad formatting or unrelated refactors
- installer identity or compatibility identifier changes

## Invariants
1. <must remain true>
2. <must remain true>

## Implementation guidance
<known architecture, relevant symbols, and constraints>

## Acceptance criteria
- [ ] <observable criterion>
- [ ] <observable criterion>

## Required validation
```powershell
<commands>
```

## Stop conditions
Stop and report without implementing a speculative workaround when:
- the contract conflicts with current behavior;
- an allowed-file restriction prevents a correct change;
- a required dependency or tool is unavailable;
- tests reveal a broader architectural problem;
- private user data would be required to continue.
```

## Delegation procedure

Codex should perform the following sequence.

### 1. Inspect

- Read relevant source files.
- Read `BUILDING.md`, `docs/protocol.md`, `CONTRIBUTING.md`, and release documentation when applicable.
- Reproduce or establish the failure before delegating whenever practical.

### 2. Create the contract

Write:

```text
docs/agent-tasks/<task-id>/contract.md
```

The contract must be sufficiently precise that implementation does not require architecture invention.

### 3. Create an isolated worktree

Use an `ag/<task-id>` branch and a separate worktree.

### 4. Invoke Antigravity

Prefer a non-interactive invocation when the installed CLI supports it. Inspect `agy --help` first.

Conceptual prompt:

```text
Read AGENTS.md and docs/agent-tasks/<task-id>/contract.md.
Implement exactly that contract.
Modify only allowed files.
Run every required validation command.
Write docs/agent-tasks/<task-id>/handoff.json and validation.log.
Stop and write failure-report.md if a stop condition is reached.
Do not merge, push, publish, or alter unrelated code.
```

If only interactive mode is available, paste the same instruction into the Antigravity session.

### 5. Wait for process completion

Codex should monitor the foreground process or inspect its exit status. Do not assume completion from silence.

### 6. Inspect the result

From the Antigravity worktree:

```powershell
git status --short
git diff --stat trunk...HEAD
git diff --check
git diff trunk...HEAD
```

Codex must compare the diff against the contract and inspect every changed file.

### 7. Verify independently

Codex should rerun critical validation commands itself. Antigravity's log is evidence, not proof.

### 8. Take over

Codex may directly amend the implementation when:

- review finds a clear bounded defect;
- Antigravity stopped at a valid stop condition;
- the remaining work is architectural or cross-layer;
- repeated delegation would cost more context than completing the change directly.

### 9. Integrate

Only after review and validation:

- commit intentionally;
- merge or cherry-pick into the target branch;
- push only when explicitly requested;
- open a draft pull request when appropriate;
- delete the worktree only after confirming that all useful work is committed.

## Handoff report format

Antigravity must write `handoff.json` using this schema:

```json
{
  "task_id": "session-lifecycle",
  "status": "completed",
  "agent": "antigravity-cli",
  "model": "<exact installed model identifier>",
  "summary": "Implemented session-scoped microphone cancellation.",
  "changed_files": [
    "app/src/main/example.ts",
    "app/tests/example.test.ts"
  ],
  "commands_run": [
    {
      "command": "bun run build",
      "exit_code": 0,
      "result": "passed"
    }
  ],
  "known_issues": [],
  "contract_deviations": [],
  "needs_codex": false
}
```

Allowed status values:

- `completed`
- `partial`
- `blocked`
- `failed`

When `needs_codex` is true, explain why in `known_issues` or `contract_deviations`.

## Codex review checklist

Codex must review for:

### Correctness

- Does the diff implement the actual acceptance criteria?
- Are error paths and cancellation paths handled?
- Are stale callbacks, repeated starts, shutdown, and restart considered?
- Does the implementation preserve existing behavior outside the scope?

### Cross-process lifecycle

- Who owns each process, socket, stream, session, and callback?
- Can a previous session mutate the current session?
- Can audio begin before service readiness?
- Can shutdown leave Python, WebSocket, microphone, or Electron resources alive?
- Are retries bounded and observable?

### Windows behavior

- Are paths valid in packaged Windows builds?
- Does the code avoid replacing Windows environments with WSL/Linux artifacts?
- Are native modules rebuilt correctly?
- Does the packaged runtime contain the required files?
- Are AppData, installer, shortcut, and compatibility identifiers preserved?

### Privacy and security

- Are logs privacy-bounded?
- Are transcript, audio, clipboard, token, and local path data excluded?
- Are external-network paths explicit and user-selected?
- Are subprocess arguments and paths safely handled?

### Testing

- Is there a regression test for the reported failure?
- Do tests assert observable behavior rather than implementation details?
- Were relevant unit, integration, build, and packaging checks run?

## Validation matrix

Run the smallest relevant set during iteration and the complete relevant set before integration.

### Python service

```powershell
Set-Location server
uv sync --extra whisper --group dev
uv run pytest
```

Use `uv sync --extra all` for release-runtime preparation involving both shipped engines.

### Desktop application

```powershell
Set-Location app
bun install
bun run test:history
bun run build
```

### Windows packaging

```powershell
Set-Location app
bun run package:win
```

Packaging checks are mandatory for changes involving:

- packaged Python discovery;
- `.runtime` or `.venv` inclusion;
- native Node modules;
- Electron Builder configuration;
- NSIS-web behavior;
- executable, shortcut, AppUserModelID, or installer identity;
- resource paths that differ between development and production.

### Protocol and lifecycle

For WebSocket, audio, readiness, session, or shutdown changes:

- run the Python test suite;
- run the application build;
- add or run targeted regression tests;
- perform a Windows smoke test when the behavior cannot be represented deterministically in unit tests.

## When Codex must not delegate

Codex should retain the task when it primarily involves:

- discovering an unknown root cause across multiple layers;
- changing application architecture;
- modifying the WebSocket protocol without an approved design;
- installer identity or migration decisions;
- security-sensitive behavior;
- release publication;
- destructive Git operations;
- unclear user requirements;
- a bug that has survived multiple implementation attempts.

Codex may still delegate a later bounded implementation after it resolves the uncertainty and writes a precise contract.

## Failure policy

Antigravity should stop and produce `failure-report.md` rather than repeatedly guessing.

The report must include:

```markdown
# Failure report

## Task ID

## Blocking condition

## Evidence

## Commands run

## Files inspected

## Partial changes

## Recommended Codex investigation
```

Codex should then inspect the evidence, decide whether to amend the contract, take over directly, or escalate model reasoning.

## Repository hygiene

- Keep task artifacts concise and factual.
- Do not commit generated model files, virtual environments, installer payloads, test audio, private logs, or local credentials.
- Do not mix unrelated fixes in one delegated task.
- Prefer one branch and one contract per independently reviewable change.
- Preserve existing authorship and provenance.
- Do not rename historical Murmur compatibility interfaces without a dedicated migration plan.

## Completion definition

A delegated task is complete only when:

1. The implementation matches the contract.
2. Codex has reviewed every changed file.
3. Required tests and builds pass.
4. Required Windows packaging or smoke checks pass when applicable.
5. No unexplained contract deviations remain.
6. The handoff report accurately reflects the final state.
7. The change is committed or otherwise preserved before worktree cleanup.

Antigravity reporting success does not by itself complete the task.