"""Presentation metadata for the supported Faster-Whisper choices.

The catalog is intentionally not an allowlist.  ``FasterWhisperAdapter`` also
accepts explicit Hugging Face repository IDs and local model paths for advanced
and offline workflows.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict

from transcription.contracts import ModelId


@dataclass(frozen=True, slots=True)
class ModelCatalogItem:
    """Presentation metadata for one supported Faster-Whisper model.

    This is the sole source of truth for model identity and the labels shown by
    the settings UI.  The catalog is deliberately separate from adapter
    validation: explicit Hugging Face repositories and local paths remain
    valid even when they are not represented here.
    """

    model: ModelId
    label: str
    summary: str
    repo_id: str
    size_gb: float
    language_label: str
    languages: tuple[str, ...]
    supports_hotwords: bool = True


class ModelCatalogPayload(TypedDict):
    """JSON-safe catalog item returned by the server settings seam."""

    model: str
    label: str
    summary: str
    repo_id: str
    size_gb: float
    language_label: str
    languages: list[str]
    supports_hotwords: bool


_LANGUAGES = ("en", "de", "fr", "es", "it", "ja", "zh", "nl", "ko", "pt")

FASTER_WHISPER_CATALOG: tuple[ModelCatalogItem, ...] = (
    ModelCatalogItem(
        model=ModelId("large-v3-turbo"),
        label="Recommended Multilingual",
        summary="A balanced multilingual option.",
        repo_id="mobiuslabsgmbh/faster-whisper-large-v3-turbo",
        size_gb=1.5,
        language_label="Multilingual",
        languages=_LANGUAGES,
    ),
    ModelCatalogItem(
        model=ModelId("large-v3"),
        label="Maximum Multilingual Accuracy",
        summary="A larger multilingual option for quality-focused use.",
        repo_id="Systran/faster-whisper-large-v3",
        size_gb=2.9,
        language_label="Multilingual",
        languages=_LANGUAGES,
    ),
    ModelCatalogItem(
        model=ModelId("medium"),
        label="Medium",
        summary="A capable multilingual option for balanced quality and speed.",
        repo_id="Systran/faster-whisper-medium",
        size_gb=1.4,
        language_label="Multilingual",
        languages=_LANGUAGES,
    ),
    ModelCatalogItem(
        model=ModelId("small"),
        label="Small",
        summary="A smaller option for constrained hardware.",
        repo_id="Systran/faster-whisper-small",
        size_gb=0.5,
        language_label="Multilingual",
        languages=_LANGUAGES,
    ),
    ModelCatalogItem(
        model=ModelId("tiny"),
        label="Tiny",
        summary="The fastest, lightest multilingual option.",
        repo_id="Systran/faster-whisper-tiny",
        size_gb=0.07,
        language_label="Multilingual",
        languages=_LANGUAGES,
    ),
)


def model_catalog_payload(
    catalog: tuple[ModelCatalogItem, ...] = FASTER_WHISPER_CATALOG,
) -> list[ModelCatalogPayload]:
    """Serialize catalog metadata into fresh, JSON-safe dictionaries.

    Returning fresh lists keeps callers from mutating the process-owned tuple
    and makes this function the one server-to-client presentation seam.
    """

    return [
        {
            "model": str(item.model),
            "label": item.label,
            "summary": item.summary,
            "repo_id": item.repo_id,
            "size_gb": item.size_gb,
            "language_label": item.language_label,
            "languages": list(item.languages),
            "supports_hotwords": item.supports_hotwords,
        }
        for item in catalog
    ]


def model_setting_options(
    catalog: tuple[ModelCatalogItem, ...] = FASTER_WHISPER_CATALOG,
) -> list[dict[str, str]]:
    """Build settings dropdown options from the canonical catalog."""

    return [
        {
            "value": str(item.model),
            "label": item.label,
            "description": item.summary,
        }
        for item in catalog
    ]


__all__ = [
    "FASTER_WHISPER_CATALOG",
    "ModelCatalogItem",
    "ModelCatalogPayload",
    "model_catalog_payload",
    "model_setting_options",
]
