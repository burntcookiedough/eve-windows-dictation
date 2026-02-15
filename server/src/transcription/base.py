"""Engine abstraction protocols and types."""

from dataclasses import dataclass, field
from enum import StrEnum, auto
from typing import Protocol, runtime_checkable

import numpy as np
from numpy.typing import NDArray

from transcription.types import TranscribeResult


class AudioMode(StrEnum):
    FULL_BUFFER = auto()   # Re-transcribe entire buffer each call (Whisper)
    INCREMENTAL = auto()   # Process only new audio since last call (Nemotron)


@dataclass(frozen=True)
class EngineInfo:
    id: str                      # "nemotron" or "whisper"
    name: str                    # "Nemotron Speech" or "Faster-Whisper"
    model: str                   # Model identifier
    mode: str                    # "streaming" or "batch-retranscribe"
    supports_hotwords: bool
    languages: list[str] = field(default_factory=lambda: ["en"])
    chunk_ms: int | None = None  # Nemotron: 160/560/1120, Whisper: None
    model_size_gb: float = 0.0


@runtime_checkable
class EngineSession(Protocol):
    def transcribe(
        self,
        audio: NDArray[np.float32],
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult: ...

    def finalize(
        self, full_audio: NDArray[np.float32] | None = None,
    ) -> TranscribeResult: ...

    def close(self) -> None: ...


@runtime_checkable
class TranscriptionEngine(Protocol):
    @property
    def audio_mode(self) -> AudioMode: ...

    @property
    def engine_info(self) -> EngineInfo: ...

    def create_session(self) -> EngineSession: ...

    def shutdown(self) -> None: ...
