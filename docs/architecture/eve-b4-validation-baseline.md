# B4 validation baseline

B4 starts from trunk `3146b3a3057ff7c55c35e6eeb63b98943f145e13`, preserving
B1/B2 and skipping B3. This is a source baseline, not a tested B4 candidate.
No B4 artifact has been packaged or authorized here. B4 is **not complete**.

| Required evidence | Current sample count / status |
| --- | --- |
| Physical microphone quality and latency | 0; pending |
| Actual insertion into isolated editor | 0; pending |
| Physical unavailable/disconnect/recovery | 0; pending |
| B4 exact-candidate replay performance | 0; pending |
| CPU before/after comparison | 0; pending; no optimization justified yet |
| Offline schema/scoring tests | Synthetic software evidence only |

The operator reports laptop mic/headset and Indian English/additional speaker
availability. Headset type, additional accent, hardware configuration, and trial
results remain unmeasured. No microphone has been accessed for this work. Obtain
agreement before every capture, including silence and warm-up, using the
[shared protocol](../development/microphone-validation-protocol.md).

## Historical comparison only

The [CPU first-run decision](eve-cpu-first-run-decision.md) used ten LibriSpeech
excerpts from different speakers, two measured runs per excerpt after one warm-up.
The packaged Windows host was a Ryzen 7 5800H with 14.9 GB usable RAM and an RTX
3060 Laptop GPU; desktop background processes remained running. See the original
[benchmark](eve-cpu-dictation-benchmark.md) for artifact/environment limitations.
Streamed recordings bypassed physical microphones and actual paste. These are
historical comparisons, not current acceptance thresholds.

| Historical configuration | n | Median stop-to-final | p95 | Raw pooled word error |
| --- | ---: | ---: | ---: | ---: |
| CPU `small`, native `int8_float32` | 20 | 3.15 s | 4.39 s | 46/384 = 12.0% |
| Optional GPU `large-v3-turbo`, native `int8_float16` | 20 | 0.81 s | 1.02 s | 26/384 = 6.8% |

Historical p95 is nineteenth sorted sample of twenty. Historical median follows
the original convention; the new harness uses nearest-rank p50. Do not combine
configurations or mix historical/new samples. This selected corpus does not
establish B4 accent, entity, noise, microphone, recovery, or insertion coverage.

Earlier profiling found inference and serialization behind partial transcription
dominated final latency. Electron display added tens of milliseconds in a few
replay trials. Disabling partials saved roughly 0.2 seconds in short tests and
could disrupt speech-based auto-stop. Thread increases did not consistently help.
These motivate measurement rather than speculative runtime changes. Fresh
packaged profiles still select `small`; saved choices remain untouched.

## Remaining evidence procedure

1. Obtain existing release-plan authorization for an exact-head candidate; record
   source commit, artifact hashes, and verification output.
2. Use isolated synthetic profiles/fixed corpus with declared warm-up/load/settings
   and comparable trial allocation.
3. Perform consented tests for available mics/speakers/conditions/modes; keep audio,
   text, profiles, and private trial files outside the repository.
4. Score and summarize per-stratum n/p50/p95, empty/failure rates, actual insertion,
   CPU/RAM, and unavailable equipment/stages.
5. Set thresholds before optimization, compare source-matched before/after artifacts
   under identical conditions, and reject quality/recovery/partial/auto-stop/resource
   regressions. No safe speedup is currently established.
6. Apply task 3's alpha gates. Unit tests/fixtures alone do not establish alpha
   readiness or broad hardware support.
