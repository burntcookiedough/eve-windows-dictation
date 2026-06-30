"""Engine abstraction protocols and types."""

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import numpy as np
from numpy.typing import NDArray

from transcription.types import TranscribeResult


@dataclass(frozen=True)
class EngineInfo:
    id: str                      # "nemotron" or "whisper"
    name: str                    # "Nemotron Speech" or "Faster-Whisper"
    model: str                   # Model identifier
    supports_hotwords: bool
    languages: list[str] = field(default_factory=lambda: ["en"])
    model_size_gb: float = 0.0
    gpu_name: str | None = None
    gpu_vram_gb: float | None = None
    estimated_max_duration_s: int | None = None
    repo_id: str | None = None
    model_path: str | None = None
    device: str | None = None
    compute_type: str | None = None
    cuda_active: bool | None = None
    load_time_s: float | None = None
    last_transcription_latency_s: float | None = None
    vram_used_gb: float | None = None


@runtime_checkable
class EngineSession(Protocol):
    def transcribe(
        self,
        audio: NDArray[np.float32],
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult: ...

    def finalize(self) -> TranscribeResult: ...

    def close(self) -> None: ...


@runtime_checkable
class TranscriptionEngine(Protocol):
    @property
    def engine_info(self) -> EngineInfo: ...

    def create_session(self) -> EngineSession: ...

    def shutdown(self) -> None: ...
