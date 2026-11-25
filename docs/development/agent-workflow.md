# Agent workflow

Use a focused branch and a concise local task contract. Inspect the relevant code,
docs, and release controls before editing. Keep local task contracts, logs, screenshots, and
handoffs out of public diffs and free of private data.

## Parallel agents

- Use one branch and one dedicated worktree per task. Never share a worktree with
  another agent. Fetch `origin` and start a `<type>/<topic>` branch from fresh
  `origin/trunk`.
- Rebase onto fresh `origin/trunk` before opening a PR. Keep each PR focused on
  one purpose.
- Assign one owner at a time to each high-conflict file.
  - `server/src/transcription/processor.py`
  - `server/src/websocket/handler.py`
  - `app/src/main/index.ts`
  - `.github/workflows/ci.yml`
- Merge only with all required checks green on the exact PR head, a clean review,
  and all conversations resolved. The required checks are `Trunk Integration Target`,
  `Version Consistency`, `App Test And Build`, and `Server Tests`.
- Agents leave tag creation, tag pushes, and release publication to the release owner.
- The Claude Code guard is a speed bump for accidental commands. It can miss
  commands after shell reserved words such as `then`. Repository permissions
  and branch protection enforce access, and protected operations require owner
  approval. The guard checks the configured destination for implicit pushes
  and allows them if both push and upstream resolution fail, subject to its
  other checks.

## Final integration

Stacked feature branches may use incremental pull requests for review, but the
final integration pull request must target `trunk`. A green check on a pull
request targeting another feature branch does not prove that the complete
reviewed stack will land on `trunk`; do not treat that pull request as the
integration merge. Confirm the `Trunk Integration Target` check passes on the
final pull request before merging, and keep that check required in `trunk`
branch protection.

Before handoff, inspect the complete diff, run `git diff --check`, and run the
smallest relevant Windows PowerShell validation. Release-critical work also requires
the applicable Gate plan/runbook and independent artifact/lifecycle verification.

Stop rather than guessing when scope, privacy, compatibility, or publication authority
is unclear. The agent that implements a change does not own merge or publication
approval.
