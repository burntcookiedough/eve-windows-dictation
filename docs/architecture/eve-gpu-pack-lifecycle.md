# Optional GPU pack lifecycle

The Electron main process owns the optional NVIDIA component. The application
descriptor remains the trust root for the two production assets: **494,950,029
compressed bytes** and **771,188,224 installed bytes**. Downloaded metadata cannot
replace its pinned URLs, sizes, hashes, or app/CTranslate2/platform identity.
Model weights and user profiles have separate owners and lifecycles.

## State and transition contract

The existing IPC states are reused. Repair and Remove are user operations rather
than new persistent runtime states; the UI marks the pending action and disables
conflicting submissions.

| Lifecycle phase | Public state and transition |
| --- | --- |
| Missing | `missing`; an explicit Download or Repair starts installation. CPU remains usable. |
| Downloading | `downloading`; progress includes verified retained compressed bytes. Completion moves to `validating`. |
| Interrupted | Retryable `failed` with `download_failed`; compatible owned partial data can resume after Retry or application restart. |
| Validating | `validating`; compressed and decompressed size/hash checks and staged validation precede publication. |
| Ready | `ready`; repeated installation or Repair revalidates without downloading a healthy exact pack. The server must start with the validated runtime to use it. |
| Failed | `failed`; integrity, ownership, storage, or compatibility errors never publish unverified files. Retryable errors expose a recovery action. |
| Repairing | The Repair action revalidates the exact pack, or follows downloading/validating for a staged restoration. Unknown data at the destination is preserved. |
| Removing | The confirmed Remove action deletes identified owned component data only, then reports `missing`. An operation conflict or living runtime lease returns a safe retryable refusal. |

An absent, malformed, or incompatible descriptor reports `unavailable` without
downloading. Renderer-facing state carries enum codes, byte counts, and pack IDs;
it never carries storage paths or asset URLs. Runtime path objects stay in main.

## Ownership and resume

Names alone do not establish ownership. Published packs require their canonical
manifest and only expected regular entries; a missing owned DLL is repairable.
Partial/staging records must be
canonical, describe manager-owned data, and agree with the permitted entries.
Unknown directories, extra files, malformed ownership records, symbolic links,
Windows junctions, and unsafe targets remain untouched. A corrupt DLL inside an
identified owned pack can be restored; an arbitrary occupied directory cannot.

Resume compatibility includes the exact descriptor identity, asset URL, compressed
size/hash, destination DLL name, and decompressed size/hash. The manager rechecks
the stored prefix against its checkpoint before requesting more bytes. Crash
bytes beyond a durable checkpoint are discarded safely within the identified
owned partial; an unowned file is never appended to or truncated.

HTTP Range handling validates `206` start/end/total boundaries against the pinned
asset. A `200` response safely restarts from zero rather than appending a complete
response to a prefix. An unsatisfiable range permits a bounded fresh restart;
malformed or inconsistent ranges fail closed. Stream writes remain size-bounded
and timed out. Truncated or interrupted transfer data is retained only under the
ownership/checkpoint policy. The completed compressed file must match its full
pinned size and SHA-256 before Brotli decompression, whose output is independently
bounded and checked against the pinned raw size and hash.

Downloads sync a checkpoint at least every 512 KiB of received data and at a
caught interruption. A complete compressed asset retains its verified checkpoint
until publication, so interruption of the second asset does not redownload the
first. Metadata reads are capped at 64 KiB.

## Disk space and publication

Before large writes, probe free space on the actual manager destination
filesystem. The peak incremental requirement includes remaining compressed
downloads, all staged decompressed bytes, bounded metadata/temporary writes, and
a safety margin. Retained installed packs already consume space in that probe;
they must not be subtracted a second time or deleted to make a failed preflight
succeed. The fixed reserve is 10 MiB for bounded metadata/temporary writes plus
a 50 MiB safety margin; it is additional to download and decompression bytes.

Insufficient space is an actionable, retryable failure. Unavailable free-space
information is reported explicitly. Preflight cannot reserve the whole volume;
disk exhaustion during download or decompression also reports retryable
`insufficient_space`. A current validated pack remains intact through failed download,
validation, preflight, or replacement.

Publication validates the complete staged pack before renaming it atomically to
the exact compatible destination. A validated published pack is immutable.
Repair never patches it in place. A corrupt owned destination is replaced only
through the staging/publication path; an unknown destination is left to its owner.

## Concurrency and server ownership

The manager serializes mutations in one instance and uses a root ownership lock
for multiple managers/processes. Identical repeated requests may share work;
conflicting operations refuse safely. A lock is recovered only with positive
evidence that its identified owner is dead. An uncertain or living owner blocks
mutation. Cleanup runs under the same operation boundary.

Stale mutation-lock recovery uses a separate exclusive recovery guard. An
occupied guard fails closed rather than risking deletion of a competing lock.
If a process crashes while holding that guard, a subsequent operation remains
blocked; isolated storage recovery requires confirming both owners are dead
before removing the guard. Do not remove unknown records automatically.

The server acquires a protected validated runtime before spawn/adoption and binds
its process identity to a durable runtime lease. Health failure, a kill request,
or a UI status change cannot release that protection. Release follows confirmed
process termination. A living server remains protected if its parent app exits;
uncertain liveness is treated conservatively.

Remove defers while a runtime may still be using component files. For a managed
server, stop it and retry after confirmed exit. Stop an external/detected server
through its owner. Remove does not interrupt active dictation automatically.
Repair and pruning honor runtime ownership too. A pack ID in server health means
the runtime was selected, not that CUDA inference is active; the effective device
distinguishes CPU fallback. Saved model/device preferences are preserved.

## Retention and recovery

| Event | Policy |
| --- | --- |
| Restart | Revalidate the exact installed pack and resume only compatible identified partial data. Recover identified abandoned state with no living owner. |
| Successful upgrade | Keep the current pack and newest validated prior pack. Living runtime leases protect additional packs from pruning. |
| Failed upgrade/replacement | Keep the validated installed pack; unverified staged data never becomes a runtime. |
| Rollback | The prior application checks its own exact descriptor again. An absent/broken/incompatible pack leaves CPU operation usable. |
| Uninstall | The supported installer's unchanged `deleteAppDataOnUninstall: false` policy retains component storage. This batch does not alter installer behavior. |
| Explicit Remove | Delete identified manager-owned current/prior component packs, owned partials, and abandoned stage/recovery data when safely unleased. Preserve unknown data, profiles, model caches, and unrelated downloads. |

Cleanup is bounded, rechecks ownership and regular entries immediately before
deletion, and verifies resolved targets remain within the intended manager root.
Automatic recovery cleans at most 16 identified abandoned stages per operation.
It does not traverse unknown subdirectories or follow links. Old staging
directories without an ownership record are unknown even if their name resembles
a manager-generated directory. An inaccessible/locked leftover is never loadable
and does not justify expanding the deletion scope.

## Evidence

Follow the [Windows lifecycle validation runbook](../development/gpu-pack-lifecycle-validation.md).
Deterministic synthetic HTTP/Brotli fixtures establish storage behavior, not GPU
inference. Full B6 acceptance additionally requires exact-candidate interruption,
restart, repeat install, upgrade, rollback, uninstall/retention, and CPU fallback
evidence on Windows. Suitable NVIDIA hardware is required for actual inference
proof. Keep B4's instrumentation and pending physical-microphone evidence separate
until later integration testing.
