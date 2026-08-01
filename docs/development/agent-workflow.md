# Agent workflow

Use a focused branch and a concise local task contract. Inspect the relevant code,
docs, and release controls before editing. Keep local task contracts, logs, screenshots, and
handoffs out of public diffs and free of private data.

Before handoff, inspect the complete diff, run `git diff --check`, and run the
smallest relevant Windows PowerShell validation. Release-critical work also requires
the applicable Gate plan/runbook and independent artifact/lifecycle verification.

Stop rather than guessing when scope, privacy, compatibility, or publication authority
is unclear. The agent that implements a change does not own merge or publication
approval.
