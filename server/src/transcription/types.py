"""Engine-agnostic transcription result type."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class TranscribeResult:
    text: str
    confidence: float  # 0.0–1.0
    last_speech_end: float | None  # Seconds from audio start; None if no speech


@dataclass(frozen=True, slots=True)
class TranscribeOptions:
    condition_on_previous_text: bool | None = None
    without_timestamps: bool | None = None
    vad_filter: bool | None = None
    temperature: float | None = None
    beam_size: int | None = None
    mode: Literal["default", "long_chunk"] = "default"
