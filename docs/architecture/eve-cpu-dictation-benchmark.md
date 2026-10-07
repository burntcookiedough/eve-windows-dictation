# Packaged Eve CPU dictation benchmark

> Historical September 2026 candidate measurements supporting the
> [CPU first-run decision](eve-cpu-first-run-decision.md). These results are not
> new measurements of the current release.

Measured on 2026-09-25/26 with the local unpacked Windows CPU candidate, not a development virtual environment. The host was a Ryzen 7 5800H (8 physical / 16 logical cores), 14.9 GB usable RAM, and an RTX 3060 Laptop GPU. Existing desktop processes remained running. The benchmark candidate's web installer payload is 178,039,346 bytes and its fresh unpacked application is 685,806,043 bytes. After packaged-runtime tests, that same unpacked directory measured 701,433,965 bytes; the exact 15,627,922-byte increase was generated `.pyc` files. Model weights are downloaded separately. A source-matched package rebuilt after review fixes measured 178,039,362 bytes for the payload and 685,806,297 bytes fresh unpacked; its packaged CPU and GPU-pack transcription smoke tests and release verifier passed. Those smoke tests are functional checks, not a new latency sample set.

## Method

The task-local harness launched the candidate's packaged Python and server, sent mono 16 kHz PCM through Eve's WebSocket protocol at real-time pace, and timed the stop command to the final transcript frame. The same files and settings were used for CPU and GPU. The five scripted clips have 2.10, 8.84, 27.22, 56.48, and 120.94 seconds of voiced audio; the shorter tests also used an 11-second JFK recording and two public LibriSpeech excerpts. The synthetic voice is unusually clean, so its word error rates cannot predict everyday microphone accuracy. Audio ending was annotated and trailing silence trimmed. One warm-up preceded measured iterations. Short-clip rows use medians of 3 to 5 iterations where available; long-clip rows are single measurements. RTF is server transcription time divided by voiced duration. CPU percent is the server process's average share of all 16 logical processors over streaming plus finalization, not just its inference interval. RAM is its maximum sampled resident set over the same interval. The full Electron/overlay test used an isolated profile and injected the same audio through the packaged preload API; it did not use a physical microphone, foreground editor, clipboard, or paste action.

The shipped default is `large-v3-turbo`, `device=auto`, `compute_type=auto`, beam 1, one transcription worker, VAD enabled (500 ms silence, 200 ms padding, threshold 0.5), and 250 ms partial interval. With no pack, CTranslate2 resolved the engine to CPU and `int8_float32`; `cpu_threads=0` left its thread choice to the library. The model loads at server startup and remains resident. The CPU tests forced `CUDA_VISIBLE_DEVICES=-1`, removed GPU/toolkit paths, used offline local model caches, and found no active CUDA driver/cuBLAS/runtime module in the server. The CTranslate2 wheel still maps its 266,288-byte `cudnn64_9.dll` dispatcher on CPU. The GPU comparison used the separately installed, hash-validated local NVIDIA pack and CUDA float16, without the system CUDA Toolkit on the process path.

## Stop to final transcript

| Configuration | Model | Native compute | Voiced audio | Stop to final | RTF | Peak server RSS | CPU | Result |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Shipped CPU default | large-v3-turbo | int8_float32 | 2.10 s | 22.25 s | 10.59 | 1,330 MiB | 24.7% | Script exact; one measured trial |
| Shipped CPU default | large-v3-turbo | int8_float32 | 8.84 s | 16.14 s | 1.82 | 1,334 MiB | 24.8% | Script exact; one measured trial |
| Shipped CPU default | large-v3-turbo | int8_float32 | 27.22 s | 25.59 s | 0.94 | 1,336 MiB | 24.6% | Script exact; one measured trial |
| Shipped CPU default | large-v3-turbo | int8_float32 | 56.48 s | 49.11 s | 0.87 | 1,340 MiB | 24.8% | Script exact; one measured trial |
| Shipped CPU default | large-v3-turbo | int8_float32 | 120.94 s | 92.02 s | 0.76 | 1,351 MiB | 24.8% | 3.5% scripted word error; one measured trial |
| CPU alternative | small | int8_float32 | 2.10 s | 3.31 s | 1.57 | 622 MiB | 23.9% | Script exact; median of 3 |
| CPU alternative | small | int8_float32 | 8.84 s | 5.32 s | 0.60 | 622 MiB | 24.6% | Script exact; median of 3 |
| CPU alternative, 8 OpenMP threads | small | int8_float32 | 2.10 s | 2.09 s | 0.99 | 624 MiB | 47.7% | Script exact; median of 2 |
| CPU alternative, 8 OpenMP threads | small | int8_float32 | 8.84 s | 4.42 s | 0.50 | 625 MiB | 48.7% | Script exact; median of 2 |
| CPU alternative, 16 OpenMP threads | small | int8_float32 | 2.10 s | 2.35 s | 1.12 | 619 MiB | 78.7% | Script exact; one measured trial |
| CPU alternative, 16 OpenMP threads | small | int8_float32 | 8.84 s | 2.73 s | 0.31 | 621 MiB | 82.6% | Script exact; one measured trial |
| CPU alternative | tiny | int8_float32 | 2.10 s | 0.61 s | 0.29 | 302 MiB | 22.9% | Script exact; median of 5 |
| CPU alternative | tiny | int8_float32 | 8.84 s | 0.84 s | 0.09 | 303 MiB | 24.5% | Script exact; median of 5 |
| CPU alternative | tiny | int8_float32 | 27.22 s | 0.86 s | 0.03 | 304 MiB | 24.7% | Script exact; one measured trial |
| CPU alternative | tiny | int8_float32 | 56.48 s | 2.17 s | 0.04 | 309 MiB | 24.8% | 0.6% scripted word error; one measured trial |
| CPU alternative | tiny | int8_float32 | 120.94 s | 4.72 s | 0.04 | 318 MiB | 24.8% | 4.7% scripted word error, including wrong date/name; one measured trial |
| Optional GPU pack | large-v3-turbo | float16 | 2.10 s | 0.37 s | 0.18 | 764 MiB | 5.7% | Script exact; median of 3 |
| Optional GPU pack | large-v3-turbo | float16 | 8.84 s | 0.63 s | 0.07 | 764 MiB | 6.1% | Script exact; median of 3 |
| Optional GPU pack | large-v3-turbo | float16 | 27.22 s | 1.16 s | 0.04 | 789 MiB | 6.2% | Script exact; one measured trial |
| Optional GPU pack | large-v3-turbo | float16 | 56.48 s | 1.70 s | 0.03 | 786 MiB | 6.2% | Script exact; one measured trial |
| Optional GPU pack | large-v3-turbo | float16 | 120.94 s | 3.65 s | 0.03 | 793 MiB | 6.2% | 3.5% scripted word error; one measured trial |

The short CPU turbo run with 8 OpenMP threads improved from 22.25 seconds to a 15.53-second median (two measured repeats). Explicit `int8` on `small` resolved to the same native `int8_float32` as `auto` and measured 3.54 seconds for 2.10 seconds of speech and 5.33 seconds for 8.84 seconds of speech (two repeats each), so merely changing compute type did not help. These alternatives were test settings, not production changes.

The 20-dictation sustained `tiny` CPU run had a 0.600-second median, 0.634-second empirical p95, and 0.532–0.638-second range. Sampled resident memory changed from 299.5 to 300.9 MiB and private memory from 812.7 to 814.0 MiB between first and last dictations; the model loaded once, server stayed alive, and the thread count did not grow. This short run does not establish multi-hour thermal behavior.

During the GPU run, `nvidia-smi` reported 3,520–3,712 MiB of **whole-device** VRAM use versus a 1,294 MiB pre-run baseline, a roughly 2.2–2.4 GiB increase. Windows WDDM did not expose per-process VRAM here, and other desktop processes occupied the GPU, so this is an approximate system delta rather than Eve's isolated VRAM allocation. The GPU server's post-load resident RAM was about 225 MiB, but its private commit was about 2.76 GiB; neither number includes the GPU allocation.

## Whole packaged app and latency stages

With a cached turbo model and no GPU pack, actual `Eve.exe` launch to HTTP server readiness took **3.96 seconds** and launch to model readiness **8.71 seconds**. The server loaded the model in 4.57 seconds. The packaged server alone reached HTTP health in about 1.6 seconds and model readiness in about 6.0 seconds. The turbo server's startup peak resident set reached 1.90 GiB and settled near 0.91 GiB after load; the full app and server processes together occupied about 1.40 GiB resident after startup. Existing memory pressure (about 2.65 GiB free after model load in one run) may have affected absolute CPU times. These are cached-model startup numbers; initial model download is excluded.

In the isolated packaged Electron test, turbo CPU stop to overlay text was **22.00 seconds** for 2.10 seconds of speech and **15.67 seconds** for 8.84 seconds. A `tiny` CPU test reached the overlay in **0.49** and **0.90 seconds** respectively; its launch to server/model readiness was **2.69/3.20 seconds**. The final callback to observed overlay DOM text took roughly 32–75 ms in these four trials. The reviewed package also reached the overlay in **0.56 seconds** with `tiny` CPU and no pack. The Lab injection path bypasses real microphone capture, clipboard, and paste, so these are overlay text timings rather than proof of text insertion into another app.

One task-local timing-hook run for the default CPU model measured 22.67 seconds from stop to final frame: audio buffer conversion 0.0002 seconds, final transcription call 12.25 seconds, and about 10.41 seconds in final-job queue/lock/executor overhead, predominantly waiting behind an active partial transcription. WebSocket response overhead was about 7 ms. VAD, preprocessing, model decoding, and postprocessing were inside the 12.25-second call and were not separated reliably. The instrumented trial agrees in scale with the uninstrumented 22.25-second trial. The bottleneck is CPU model work and serialization with partials, not the Electron text path.

## Quality, size, and decision

The `tiny` model was fast, but on the 120-second script it changed “March 18” to “March 8” and “Northstar” to “North Star”; it also scored 5.9% and 6.3% word error on the two public human excerpts. `small` retained the date but also split “Northstar”; its human excerpt errors were 5.9% and 3.1%. Turbo on GPU scored 5.9% and 0% on those excerpts and retained the scripted date/name. The sample set is too small and clean to justify silently changing every CPU user's default to `tiny`, especially for names, dates, and amounts.

The measured `large-v3-turbo` CPU path is **not responsive enough for ordinary short dictation**. These benchmark runs predate the fresh-profile model choice: packaged Windows profiles that are genuinely new now seed `small`, unless `MURMUR_WHISPER_MODEL` is explicitly set. Existing profiles and explicit model choices are preserved. The benchmark's `small` results were faster than turbo on CPU, but the synthetic clips and small public sample set do not establish real-microphone accuracy across users. Neither an OpenMP-only change nor explicit INT8 made the measured turbo CPU path responsive. The GPU pack accelerated turbo in these tests and is now published as a separate prerelease pinned by the alpha.6 candidate descriptor; the Eve app release and its remaining gates are still open. It costs about 495 MB compressed and 771 MB installed, independently of the 178 MB CPU installer.

The source files and JSONL measurements are held in the task-local `cpu-benchmark` artifact directory, outside the application and installer. This benchmark did not test a machine without an NVIDIA driver, a fresh download, a physical mic, actual paste, multi-hour use, or in-place upgrade/rollback. It did reproduce CPU-only runtime identity, no active CUDA runtime modules, cached cold start, short/long backend timing, overlay text timing, a 20-dictation stability run, and optional-pack CUDA transcription with the same audio.
