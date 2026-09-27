# Draft NVIDIA licensing inquiry: Eve optional CUDA cuBLAS runtime

**Status: UNSENT DRAFT — for review only. Do not send without authorization.**

**To (suggested):** nvidia-compute-license-questions@nvidia.com
**Subject:** CUDA 12.9.1.4 cuBLAS redistribution in Eve Windows application

Hello NVIDIA licensing team,

We are evaluating an optional Windows x64 GPU feature in Eve, a Windows dictation application. Eve provides material functionality beyond cuBLAS. The feature would use only `cublas64_12.dll` and `cublasLt64_12.dll` from NVIDIA's CUDA 12.9.1.4 Windows x64 cuBLAS redistributable. Eve would install the DLLs in Eve-controlled application storage and load them only for Eve's GPU transcription service. The official redistributable manifest identifies the component as `CUDA Toolkit` and lists `libcublas/LICENSE.txt` as its license path.

We read CUDA 12.9.1 EULA §§1.1.1–1.1.2, §1.2(2), §2.5, and Attachment A §2.6. The EULA allows specified portions to be distributed as object code incorporated into an application, subject to its distribution requirements; it lists Windows `cublas.dll` and `cublasLt.dll`, including filename variants. Before enabling distribution, could you please answer the following for these two DLLs and the delivery flows below?

1. **A — Eve-hosted assets:** May Eve host the two DLLs as Brotli-compressed `.br` release assets at public, immutable URLs and have Eve fetch them only after the user opts into GPU support? The URLs would be publicly reachable if known, but Eve would be the intended downloader, would decompress and install the DLLs in Eve-controlled storage, and would be the only application to load them. Does this meet the requirement that the distributable portions be accessed only by the application and the restriction against a standalone SDK product? Does the answer change if Eve gates downloads with short-lived, app-issued URLs or equivalent access controls?

2. **B — NVIDIA-hosted archive:** May Eve instead fetch NVIDIA's own official [`libcublas-windows-x86_64-12.9.1.4-archive.zip`](https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-12.9.1.4-archive.zip), verify it against the manifest, extract only `cublas64_12.dll` and `cublasLt64_12.dll` into Eve-controlled storage, and discard the archive without hosting or redistributing it? Would that be permitted, and does NVIDIA require a particular user-facing flow for this method?

3. **User acceptance and terms:** For either method, must Eve obtain each end user's separate click-through acceptance of the NVIDIA CUDA Toolkit EULA before download or use? Or may Eve's own user terms carry the required restrictions and protections? Please specify any required acceptance flow or terms that Eve must present.

4. **License and attribution materials:** The [CUDA 12.9.1 redistributable manifest](https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.1.json) points to [`libcublas/LICENSE.txt`](https://developer.download.nvidia.com/compute/cuda/redist/libcublas/LICENSE.txt), whose text says it was last updated January 12, 2024; the [archived CUDA 12.9.1 EULA](https://docs.nvidia.com/cuda/archive/12.9.1/eula/index.html) says it was last updated January 7, 2025. Which text governs cuBLAS 12.9.1.4, and which exact license/notice texts must accompany these DLLs? In particular, should Eve ship the component `LICENSE.txt`, the 12.9.1 EULA, or both? The EULA Attachment B items 6–10 and 18 identify third-party code used in cuBLAS; please confirm whether those are the complete applicable notices for this DLL pair, and whether they must be reproduced in a readable file shipped with Eve rather than linked online.

5. **Other required wording:** Is a statement that NVIDIA does not sponsor or endorse Eve sufficient for the no-endorsement term, and are there any other notices or restrictions specific to this two-DLL distribution?

The candidate archive is version 12.9.1.4; the manifest records SHA-256 `d534d98b0b453a98914dbf3adf47d7e84b55037abf02f87466439e1dcef581ed`. Eve has not enabled production asset URLs or distributed this candidate. If neither method is covered by the published EULA, please identify the permitted distribution path or the additional written agreement required.

Thank you,
Eve team
