# Gate 6C publication runbook

1. Merge the reviewed preparation PR and freeze its exact commit.
2. Run the single authorized final-head package and full lifecycle validation; stop on failure.
3. Generate the seven-asset manifest/checksum set and rehash it independently.
4. Create the exact annotated tag only after acceptance; tag pushes do not trigger a workflow.
5. Manually create a draft release and upload exactly the manifest, SHA256/SHA512 sums,
   third-party notice, wrapper, payload, and `latest.yml`.
6. Dispatch the verifier with exact tag, commit, manifest hash, `allow_unsigned=true`, and
   `accepted_name_risk=true`. It downloads and verifies only; it never builds or uploads.
7. A configured `production-release` environment reviewer approves the promotion job.
   The job re-downloads and re-verifies, then changes only `draft=false`.
8. Download public assets and compare hashes. On any mismatch stop: never move the tag or
   replace assets. Preserve evidence and follow the incident withdrawal procedure.
