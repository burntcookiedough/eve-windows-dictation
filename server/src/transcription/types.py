"""Engine-agnostic transcription result type."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TranscribeResult:
    text: str
    confidence: float  # 0.0–1.0
    last_speech_end: float | None  # Seconds from audio start; None if no speech
