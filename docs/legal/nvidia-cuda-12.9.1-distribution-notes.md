# NVIDIA CUDA 12.9.1 distribution notes

Status: review draft for the optional Eve Windows x64 GPU pack. This is not legal advice or redistribution approval.

## Exact component under review

NVIDIA's [CUDA 12.9.1 redistributable manifest](https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.1.json) identifies `libcublas` as “CUDA cuBLAS,” version 12.9.1.4, license “CUDA Toolkit,” and points to `libcublas/LICENSE.txt`. The Windows x64 archive is `libcublas-windows-x86_64-12.9.1.4-archive.zip`, 549,755,186 bytes, SHA-256 `d534d98b0b453a98914dbf3adf47d7e84b55037abf02f87466439e1dcef581ed`.

The candidate pack contains only these two DLLs from that archive:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `cublas64_12.dll` | 102,518,272 | `90052a83efd1b57a8e3616a6590b335855f81b814a4f16eecb7b5bf6d1b1d4eb` |
| `cublasLt64_12.dll` | 668,669,952 | `c3a05ea244c937314afec09f87b91f814c7e27977681f6c67eb51bb06ced3a4a` |

Their candidate Brotli files and hashes are recorded in [the GPU pack provenance](../architecture/eve-gpu-pack-provenance.md). Keep NVIDIA's other archive members out of the Eve pack.

## Terms that govern this distribution

The [CUDA 12.9.1 EULA](https://docs.nvidia.com/cuda/archive/12.9.1/eula/index.html) grants distribution of listed SDK portions as object code incorporated into an application that meets the EULA's requirements (§§1.1.1–1.1.2). It requires the application to add material functionality and limits access to the redistributable SDK portions to that application. The EULA also bars distributing the SDK as a stand-alone product (§1.2.2). Attachment A lists Windows `cublas.dll` and `cublasLt.dll`; it permits filename variants with version or architecture information.

Eve adds material functionality and its manager loads only a validated pack for Eve's managed server. The unresolved issue is the delivery boundary. A user-requested pack downloaded from a separately hosted URL still needs review against the application-only access and stand-alone product clauses. Do not turn on a production descriptor or publish the pack until that delivery method is cleared.

## Notice draft

> Eve's optional Windows x64 GPU runtime includes NVIDIA CUDA cuBLAS 12.9.1.4 components, `cublas64_12.dll` and `cublasLt64_12.dll`. NVIDIA identifies these files as CUDA Toolkit redistributables. They are supplied under the NVIDIA CUDA Toolkit EULA, subject to its terms. The applicable license text is NVIDIA's `libcublas/LICENSE.txt` from the CUDA 12.9.1 redistributable distribution. NVIDIA does not sponsor or endorse Eve.

This is draft wording only. The exact NVIDIA license text and the third-party notices required for the two DLLs must be included with the final Eve distribution. The EULA's Attachment B contains binary notice obligations for third-party code included in CUDA libraries, including code identified as used in cuBLAS. Review which notices apply to these exact DLLs and carry the applicable copyright, license, and disclaimer text in readable distribution materials. A single `NVIDIA CUDA EULA` inventory row or a link alone has not been checked as sufficient.

## Release checks still required

- Review the planned download host and access path against the EULA's distribution grant and restrictions.
- Carry and verify the matching `libcublas/LICENSE.txt` and applicable Attachment B notices in the Eve legal resources that ship with the exact candidate.
- Rebuild from the exact official archive using `scripts/prepare-gpu-pack.mjs`; compare both compressed and raw size/hash pairs with the reviewed values.
- Run short and long GPU dictation in the packaged alpha.6 app on clean Windows without the CUDA Toolkit, then exercise install, repair, update, rollback, and uninstall with a synthetic profile.
- Keep the pack unavailable if any legal or clean-machine gate is open.
