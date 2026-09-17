"""Presentation metadata for the supported Faster-Whisper choices.

The catalog is intentionally not an allowlist.  ``FasterWhisperAdapter`` also
accepts explicit Hugging Face repository IDs and local model paths for advanced
and offline workflows.
"""

from __future__ import annotations

from dataclasses import dataclass

from transcription.contracts import ModelId


@dataclass(frozen=True, slots=True)
class ModelCatalogItem:
    model: ModelId
    label: str
    repo_id: str
    size_gb: float
    languages: tuple[str, ...]
    supports_hotwords: bool = True


_LANGUAGES = ("en", "de", "fr", "es", "it", "ja", "zh", "nl", "ko", "pt")

FASTER_WHISPER_CATALOG: tuple[ModelCatalogItem, ...] = (
    ModelCatalogItem(
        model=ModelId("large-v3-turbo"),
        label="Large V3 Turbo",
        repo_id="mobiuslabsgmbh/faster-whisper-large-v3-turbo",
        size_gb=1.5,
        languages=_LANGUAGES,
    ),
    ModelCatalogItem(
        model=ModelId("large-v3"),
        label="Large V3",
        repo_id="Systran/faster-whisper-large-v3",
        size_gb=2.9,
        languages=_LANGUAGES,
    ),
    ModelCatalogItem(
        model=ModelId("medium"),
        label="Medium",
        repo_id="Systran/faster-whisper-medium",
        size_gb=1.4,
        languages=_LANGUAGES,
    ),
    ModelCatalogItem(
        model=ModelId("small"),
        label="Small",
        repo_id="Systran/faster-whisper-small",
        size_gb=0.5,
        languages=_LANGUAGES,
    ),
    ModelCatalogItem(
        model=ModelId("tiny"),
        label="Tiny",
        repo_id="Systran/faster-whisper-tiny",
        size_gb=0.07,
        languages=_LANGUAGES,
    ),
)


__all__ = ["FASTER_WHISPER_CATALOG", "ModelCatalogItem"]
