# Eve alpha.9 release plan

The user requested PR review, merge, post-merge verification and a new published
build on 2026-10-30. This plan records the candidate gates for that request.

## Scope and frozen boundaries

Release the compact pill integrated by PR #127. Use version 0.8.2-alpha.9 and
preserve the Eve application ID, NSIS GUID, Murmur identifiers, profiles, protocols,
model cache, runtime dependency closure and published assets. Rebind the optional
GPU descriptor to the candidate app version without changing its asset hashes.

## Gates

1. Review the version, descriptor, lifecycle bindings and release notes through a
   PR targeting trunk. Require all four CI checks and CodeRabbit review.
2. Verify post-merge trunk CI and freeze the exact candidate commit. Dispatch the
   existing Windows Installer Lifecycle Gate from trunk with that expected commit
   and retained QA artifacts. Its historical alpha.5 baseline remains fixed.
3. Require passing install, synthetic profile, Quick/Long Dictation, upgrade,
   rollback, uninstall and owned-process cleanup evidence. Independently verify
   retained artifact identity, payload manifest and checksums. Stop on failures.
4. Record candidate bytes, runtime and GPU evidence and remaining real microphone
   or clean-machine limitations. Do not infer such acceptance from unit tests.
5. Prepare an immutable tag, draft and exact asset manifest only after acceptance.
   The promotion workflow requires explicit unsigned-wrapper and Eve name-risk
   acceptance; do not invent either input. Complete the concrete candidate and
   evidence before requesting any missing release-policy acceptance.
6. Promote through the protected workflow from trunk as a prerelease, never
   latest, then download public assets and compare their hashes. Preserve all
   historical tags, release assets and hashes.

### Draft transport recovery

Local payload uploads to the accepted alpha.9 draft timed out. The manual
`alpha9-draft-payload.yml` workflow may transfer only the missing payload from
successful retained-candidate run 41134097556 to draft 429752581. It pins the
accepted source commit and manifest hash, validates every existing asset, and
refuses replacement, incomplete assets, changed draft identity, or publication.
It runs only from this repository's trunk and shares the promotion concurrency
group. Publication still uses the existing protected `release.yml` workflow.

## Initial evidence

PR #127 head 3348cbebde8eec8f77f1e5d6252adbbd48e9c337 passed all four required
checks and CodeRabbit CLI review reported zero issues. Its squash merge is
89233cc0ddef49310ae7e46a6fbff44b55a944cd. Local Windows validation passed 456 app
tests and 579 server tests; one hosted native clipboard test was skipped locally.
The initial hosted server run timed out in a Node test subprocess; its rerun
passed. Candidate installer evidence remains pending.
