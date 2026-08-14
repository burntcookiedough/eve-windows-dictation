# Speech model selection

The v0.8.1 alpha presents three curated Whisper choices. Nemotron remains in
the source tree and optional `nemotron` extra for deferred repair work; it is
not shipped or user-selectable in this alpha:

- Recommended Multilingual: Faster-Whisper `large-v3-turbo` (multilingual, approximately 1.5 GB).
- Maximum Multilingual Accuracy: Faster-Whisper `large-v3` (multilingual, approximately 2.9 GB).
- Lightweight: Faster-Whisper `small` (multilingual, approximately 0.5 GB).

The labels describe relative use cases, not Eve benchmark claims. The packaged
alpha exposes Whisper only; engine availability still comes from the running
server, and a missing engine runtime is not installed by this UI.

Selecting a choice is local to the renderer. **Apply and prepare model** is the explicit action that persists the existing server settings and begins the existing engine/model swap path. Eve keeps the current engine active while the selected model downloads or loads where the server supports that behavior. A selected choice is not called current until the server reports that engine and model ready.

The bundled engine runtime and separately downloaded model weights are different lifecycles. Eve reports only the selected/active model-download state; it does not inventory, pre-download, move, or delete model caches. Hugging Face cache partials remain resumable through the existing server download plumbing.

Before a missing or partial selected-model download begins, the server checks free capacity on the existing Hugging Face cache filesystem (or its nearest existing parent). It estimates remaining selected-repository bytes from model metadata and already-present required files, with the larger of 10% or 512 MiB reserved as cushion. The check reads capacity and selected-repository metadata only; an unavailable or insufficient filesystem produces an explicit selected-model error and leaves partial data untouched.
