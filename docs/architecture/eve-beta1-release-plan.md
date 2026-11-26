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

   Require success for the overall run and all phases. Record the run ID as
   `$candidateRun`. Within seven days, download
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

   Require passing functional History across upgrade, relaunch, and rollback.
   Record both SHAs and preserve `eve-retained-history-evidence-<run-id>` within
   seven days. A change to packaging inputs requires a fresh candidate and
   acceptance evidence for its bytes.
5. Obtain owner approval for trial limits and exact-artifact testing, then
   complete the [physical G3–G10 and GPU gates](../development/alpha-quality-gates.md)
   with consent and isolated QA state. Record reviewed results against the
   accepted hashes and resolve mandatory failures before tagging.
6. After owner approval, create the annotated tag on the accepted commit and
   upload the seven verified files to a prerelease draft with the
   [beta.1 notes](../releases/eve-v0.9.0-beta.1-release-notes.md).
   Use the [protected promotion runbook](eve-gate-6c-publication-runbook.md)
   with explicit unsigned-wrapper and name-risk decisions. Verify the public
   prerelease and every download before updating published references.
