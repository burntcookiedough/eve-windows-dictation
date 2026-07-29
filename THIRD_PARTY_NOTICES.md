# Third-party distribution notice record

This tracked record describes the notice process for Eve Windows binaries. The generated
`legal/THIRD_PARTY_NOTICES.txt` inside a release candidate is the closure-derived notice
file for that exact candidate; it is not a legal opinion or trademark clearance.

The generator inventories the production Node closure, Electron/Chromium notices,
managed Python, packaged Python distributions, and native ASR/CUDA/CTranslate2/ONNX
components. It fails when a shipped component has neither embedded license material nor
a reviewed entry in `config/third-party-license-overrides.json`.

`LICENSE`, `NOTICE.md`, this record, Electron's `LICENSE.electron.txt`, Chromium's
`LICENSES.chromium.html`, and the managed Python license material are shipped as readable
distribution resources. CUDA redistribution eligibility is reviewed against the applicable
NVIDIA Attachment A for the final DLL inventory; an SPDX-like metadata label alone is not
treated as authority.

Models are downloaded separately and are not installer payloads. Final validation records
the exact model revision and governing terms for `nvidia/nemotron-speech-streaming-en-0.6b`
and `mobiuslabsgmbh/faster-whisper-large-v3-turbo`. Those terms may change upstream and
must be authoritatively rechecked before publication.
