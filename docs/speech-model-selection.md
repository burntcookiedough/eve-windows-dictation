# Speech model selection

Eve currently supports one model family: Faster-Whisper running through the
CTranslate2 adapter. The built-in catalog contains these curated choices:

- Recommended multilingual: `large-v3-turbo` (approximately 1.5 GB).
- Maximum multilingual accuracy: `large-v3` (approximately 2.9 GB).
- Lightweight: `small` (approximately 0.5 GB).
- Advanced: `medium` (approximately 1.4 GB) and `tiny` (approximately 0.07 GB).

The labels describe relative use cases, not Eve benchmark claims. Catalog entries
are presentation metadata, not an allowlist: advanced users may provide an explicit
Faster-Whisper Hugging Face repository or local model path through server settings.

**Apply and prepare model** is the explicit action that persists server settings and
asks the model runtime to prepare the selected model. Eve keeps the current ready
model serving sessions while a replacement downloads, loads, validates, and commits.
A selection is not current until the server reports that model ready; a failed
candidate leaves the previous model usable.

The bundled runtime and separately downloaded model weights have different lifecycles.
Eve reports the selected model's preparation state but does not inventory, move, or
delete model caches. Hugging Face partial downloads remain resumable through the
server's existing download plumbing.

Before a missing or partial download begins, the server checks free capacity on the
existing Hugging Face cache filesystem (or its nearest existing parent). It estimates
remaining repository bytes from model metadata and already-present required files,
reserving the larger of 10% or 512 MiB as a cushion. An unavailable or insufficient
filesystem produces an explicit model-preparation error and leaves partial data intact.
