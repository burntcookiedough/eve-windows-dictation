"""Small, Faster-Whisper-facing contracts used by the model runtime.

The runtime deliberately knows about one model family today.  These types are
the narrow seam a future adapter would satisfy; they do not expose discovery,
transport, or optional engine selection to callers.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, NewType, Protocol, TypeAlias, runtime_checkable

import numpy as np
from numpy.typing import NDArray

from transcription.types import TranscribeOptions, TranscribeResult

ModelId = NewType("ModelId", str)
SessionId = NewType("SessionId", str)

Device = Literal["auto", "cpu", "cuda"]
ComputeType = Literal["auto", "int8", "int8_float16", "float16", "float32"]


@dataclass(frozen=True, slots=True)
class WhisperConfig:
    """Validated-at-the-boundary settings required to prepare Whisper.

    Defaults mirror the current Eve alpha settings so tests and composition
    code can construct a complete configuration without importing ``config``.
    The server settings boundary remains responsible for parsing persisted and
    environment values into this type.
    """

    model: ModelId = ModelId("large-v3-turbo")
    device: Device = "auto"
    compute_type: ComputeType = "auto"
    language: str | None = "en"
    beam_size: int = 1
    temperature: float = 0.0
    condition_on_previous_text: bool = False
    without_timestamps: bool = True
    vad_filter: bool = True
    vad_min_silence_duration_ms: int = 500
    vad_speech_pad_ms: int = 200
    vad_threshold: float = 0.5


@dataclass(frozen=True, slots=True)
class ModelInfo:
    """Prepared-model identity, capability, and runtime telemetry.

    ``size_gb`` is the presentation estimate; the other fields are measured or
    discovered during preparation/transcription.  The ``model_size_gb``
    property keeps migration adapters readable while the domain name remains
    model-oriented.
    """

    model: ModelId
    repo_id: str | None = None
    model_path: str | None = None
    size_gb: float = 0.0
    languages: tuple[str, ...] = ("en",)
    device: Device = "auto"
    compute_type: str = "auto"
    cuda_active: bool = False
    load_time_s: float = 0.0
    supports_hotwords: bool = True
    gpu_name: str | None = None
    gpu_vram_gb: float | None = None
    estimated_max_duration_s: int | None = None
    last_transcription_latency_s: float | None = None
    vram_used_gb: float | None = None

    @property
    def model_size_gb(self) -> float:
        """Compatibility spelling for code still translating ``EngineInfo``."""

        return self.size_gb


@runtime_checkable
class ModelSession(Protocol):
    """A session pinned to one prepared model generation."""

    def transcribe(
        self,
        audio: NDArray[np.float32],
        *,
        hotwords: str | None = None,
        options: TranscribeOptions | None = None,
    ) -> TranscribeResult: ...

    def finalize(self) -> TranscribeResult: ...

    def close(self) -> None: ...


@runtime_checkable
class PreparedModel(Protocol):
    """A fully loaded model that can create sessions and be shut down."""

    @property
    def info(self) -> ModelInfo: ...

    def open_session(self) -> ModelSession: ...

    def shutdown(self) -> None: ...


@dataclass(frozen=True, slots=True)
class PreparationProgress:
    """Progress owned by one runtime preparation generation."""

    candidate: ModelId
    phase: str
    percent: float | None = None
    detail: str | None = None
    generation: int | None = None

    @property
    def model(self) -> ModelId:
        """Alias for callers that describe progress in model terminology."""

        return self.candidate


ProgressSink: TypeAlias = Callable[[PreparationProgress], None]


@runtime_checkable
class ModelAdapter(Protocol):
    """The only implementation seam needed for a future model family."""

    def prepare(
        self,
        config: WhisperConfig,
        progress: ProgressSink,
    ) -> PreparedModel: ...


@dataclass(frozen=True, slots=True)
class PublicModelError:
    """Stable, bounded error data safe for health/settings responses."""

    code: str
    message: str


@dataclass(frozen=True, slots=True)
class Starting:
    kind: Literal["starting"] = "starting"


@dataclass(frozen=True, slots=True)
class Preparing:
    current: ModelInfo | None
    candidate: ModelId
    progress: PreparationProgress | None = None
    active_sessions: int = 0
    kind: Literal["preparing"] = "preparing"


@dataclass(frozen=True, slots=True)
class Ready:
    model: ModelInfo
    active_sessions: int = 0
    draining_sessions: int = 0
    kind: Literal["ready"] = "ready"


@dataclass(frozen=True, slots=True)
class Failed:
    current: ModelInfo | None
    candidate: ModelId
    error: PublicModelError
    kind: Literal["failed"] = "failed"


@dataclass(frozen=True, slots=True)
class Stopping:
    kind: Literal["stopping"] = "stopping"


RuntimeStatus: TypeAlias = Starting | Preparing | Ready | Failed | Stopping


__all__ = [
    "ComputeType",
    "Device",
    "Failed",
    "ModelAdapter",
    "ModelId",
    "ModelInfo",
    "ModelSession",
    "PreparedModel",
    "PreparationProgress",
    "Preparing",
    "ProgressSink",
    "PublicModelError",
    "Ready",
    "RuntimeStatus",
    "SessionId",
    "Starting",
    "Stopping",
    "TranscribeOptions",
    "TranscribeResult",
    "WhisperConfig",
]
