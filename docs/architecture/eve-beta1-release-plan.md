# Eve v0.9.0-beta.1 release plan

The beta candidate uses the existing unsigned Windows web installer path and
the pinned alpha.5 upgrade and rollback baseline. It reuses the existing optional
NVIDIA pack. The exact-tag version check also verifies the CTranslate2 wheel pin.

## Freeze and retain the candidate

1. Review the preparation PR, require the four trunk CI checks and CodeRabbit
   review, then verify post-merge trunk CI. Freeze the full lowercase commit
   SHA as `$candidate` and run `python scripts/version.py check --tag v0.9.0-beta.1`
   on that commit. Record the reviewed PR, checks, SHA, and version output.
2. With owner approval for the exact-head lifecycle run and upload, dispatch
   the hosted installer gate from trunk in Windows PowerShell.

   ```powershell
   gh workflow run installer-lifecycle-ci.yml --ref trunk -f "expected_commit=$candidate" -f retain_candidate=true
   ```

   Require the overall run and all phases to pass. Record the lifecycle evidence
   for installation, upgrade, rollback, and installed bytes. The same-bytes
   History probe supplies settings persistence evidence, and the physical
   trials supply app-level Quick and Long Dictation evidence. Require all
   three results before tagging. Record the run ID as `$candidateRun`.
   Within seven days, download
   `eve-v0.9.0-beta.1-unsigned-candidate-qa-$candidateRun`. Record the artifact ID
   as `$artifactId` and preserve the archive digest, size, seven release files,
   and three QA JSON files.
3. With owner approval for exact-artifact verification, independently hash the
   release manifest as `$manifestHash` and compare it with the retained provenance.
   For the approved unsigned QA path, verify the complete bundle at `$retainedDir`.

   ```powershell
   ./scripts/release-artifacts.ps1 -Mode Verify -ArtifactDir $retainedDir -ExpectedTag v0.9.0-beta.1 -ExpectedCommit $candidate -ExpectedManifestSha256 $manifestHash -AllowUnsigned
   ```

   Follow [procedure B](../development/alpha-quality-gates.md) to verify installed
   bytes and runtime. Pass the retained `qa/candidate-payload-manifest.json` to
   `release-verify.ps1` as `-ManifestPath`. Record the unsigned-wrapper decision,
   runtime results, and artifact hashes.

## Qualify and publish the accepted bytes

4. With owner approval for the History run and aggregate evidence upload, set
   `$harness` to the full lowercase SHA of the reviewed harness on trunk.

   ```powershell
   gh workflow run retained-history-ci.yml --ref trunk -f "expected_commit=$harness" `
     -f candidate_source=retained -f "candidate_id=$artifactId" -f "candidate_commit=$candidate" `
     -f candidate_tag=v0.9.0-beta.1 -f "expected_manifest_sha256=$manifestHash"
   ```

   Require passing functional History across upgrade, relaunch, and rollback,
   plus verification that the candidate reads seeded settings and retains a
   changed appearance setting after relaunch.
   Record both SHAs and preserve `eve-retained-history-evidence-<run-id>` within
   seven days. A change to packaging inputs requires a fresh candidate and
   acceptance evidence for its bytes.
5. Obtain owner approval for exact-artifact testing, then complete the
   [physical G3–G10 and GPU gates](../development/alpha-quality-gates.md)
   with consent and isolated QA state. Apply the [frozen beta pass/fail
   limits](#frozen-beta-passfail-limits) and record reviewed results against the
   accepted hashes before tagging.
6. After owner approval, create the annotated tag on the accepted commit and
   upload the seven verified files to a prerelease draft with the
   [beta.1 notes](../releases/eve-v0.9.0-beta.1-release-notes.md).
   Use the [protected promotion runbook](eve-gate-6c-publication-runbook.md)
   with explicit unsigned-wrapper and name-risk decisions. Verify the public
   prerelease and every download before updating published references.

## Frozen beta pass/fail limits

The owner froze these limits on 2026-11-13 before any physical trial. Keep
them fixed. A miss requires a fix and retest or an explicit owner decision
recorded with the trial data.

Run the four CPU configurations formed by the laptop mic and Apple USB-C mic,
each in quiet and moderate noise. Each configuration gets 20 Quick trials using
fictional scripts of 5–15 seconds and one 30-minute Long trial. With the GPU pack,
repeat the quiet Apple USB-C configuration with 20 Quick trials and one
30-minute Long trial.

| Area | Limit |
|---|---|
| Insertion | Every trial's final text inserted **exactly once** in the test editor: 0 duplicates, 0 lost finals. Clipboard restored in 100% of trials where configured. |
| Empty/failed output | Unexpected empty or failed results ≤ 1 per 20 Quick trials per config, and 0 for Long. |
| Accuracy, Quick | WER ≤ 12% per config, quiet. ≤ 18% per config, moderate noise. |
| Accuracy, Long | WER ≤ 15%, quiet. ≤ 20%, moderate noise. No dropped or duplicated chunk. |
| Fictional names/numbers/terms | ≥ 85% exactly right per config. |
| Quick latency, CPU | Stop → text inserted: p50 ≤ 1.5 s, p95 ≤ 3.0 s. |
| Quick latency, GPU | Stop → text inserted: p50 ≤ 0.8 s, p95 ≤ 1.5 s. |
| Long finalization | Stop → final inserted after 30 min: ≤ 90 s on CPU, ≤ 20 s on GPU. |
| Memory | App + server RSS ≤ 1.5 GiB idle after the model loads, ≤ 2.5 GiB peak during Long. No more than 15% growth between minute 5 and minute 30 of Long. |
| CPU when idle | Average below 2% of total CPU over 2 idle minutes, with no recording. |
| Robustness (G3–G7) | Every scripted scenario passes: 0 hangs, 0 duplicate finals, 0 lost History entries. The next trial succeeds after each forced failure. Synthetic canary text never appears in logs. |
| GPU pack (G9) | Install, interrupt, corrupt, wrong version, repair, remove: all handled. GPU failure or pack removal falls back to working CPU dictation without changing the user's saved choice. |
| Install/upgrade/rollback (G2) | Hosted lifecycle and History gates pass on the final beta build. |

Scoring: WER is calculated on normalized text (lowercase, no punctuation). Empty output when a reference exists counts as 100% deletions. Every attempted trial counts. n = 20 gives a rough p95 only; report the exact sample count with every percentile.
