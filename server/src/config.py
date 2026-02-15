"""Configuration management using pydantic-settings."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

SETTINGS_FILE = Path(__file__).parent.parent / "settings.json"


def _load_settings_json() -> dict[str, Any]:
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text())
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to read settings.json: %s", e)
    return {}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MURMUR_",
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # Server settings
    host: str = "0.0.0.0"
    port: int = 51717
    max_sessions: int = 10
    start_timeout: float = 10.0

    # Engine selection (Nemotron is default)
    engine: Literal["nemotron", "whisper"] = "nemotron"

    # Whisper settings
    whisper_model: str = "large-v3-turbo"
    whisper_device: Literal["auto", "cpu", "cuda"] = "auto"
    whisper_compute_type: Literal[
        "auto", "int8", "int8_float16", "int16", "float16", "float32"
    ] = "auto"

    # Nemotron settings
    nemotron_model: str = "nvidia/nemotron-speech-streaming-en-0.6b"
    nemotron_device: Literal["auto", "cpu", "cuda"] = "auto"

    # Transcription settings
    partial_emission_interval: float = 0.25
    min_audio_for_transcription: float = 0.15

    # Hot-swap
    unload_before_swap: bool = False

    # Logging
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_binary: bool = False


# Settings metadata for dynamic UI rendering
SETTINGS_METADATA: dict[str, dict[str, Any]] = {
    "engine": {
        "label": "Transcription Engine",
        "description": "The speech recognition engine to use",
        "type": "select",
        "options": [
            {"value": "nemotron", "label": "Nemotron Speech", "description": "Fast batch retranscribe, ~93x real-time. English. ~2.3 GB model."},
            {"value": "whisper", "label": "Faster-Whisper", "description": "Batch retranscribe mode. 25+ languages. ~1.5 GB model."},
        ],
        "requires_reload": True,
        "category": "engine",
    },
    "nemotron_model": {
        "label": "Nemotron Model",
        "description": "Model name or path for Nemotron engine",
        "type": "text",
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "nemotron"},
    },
    "nemotron_device": {
        "label": "Device",
        "description": "Compute device for Nemotron engine",
        "type": "select",
        "options": [
            {"value": "auto", "label": "Auto (recommended)"},
            {"value": "cuda", "label": "CUDA"},
            {"value": "cpu", "label": "CPU"},
        ],
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "nemotron"},
    },
    "whisper_model": {
        "label": "Whisper Model",
        "description": "Model size. Larger = better quality, more VRAM.",
        "type": "select",
        "options": [
            {"value": "large-v3-turbo", "label": "Large V3 Turbo", "description": "Best speed/quality balance (~1.5 GB model)"},
            {"value": "large-v3", "label": "Large V3", "description": "Highest quality, slower"},
            {"value": "medium", "label": "Medium", "description": "~1.4 GB model"},
            {"value": "small", "label": "Small", "description": "~0.5 GB model"},
            {"value": "tiny", "label": "Tiny", "description": "Fastest, lowest quality"},
        ],
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_compute_type": {
        "label": "Compute Precision",
        "description": "Lower precision = faster + less VRAM but slightly lower quality",
        "type": "select",
        "options": [
            {"value": "auto", "label": "Auto (recommended)"},
            {"value": "float16", "label": "Float16"},
            {"value": "int8_float16", "label": "Int8+Float16"},
            {"value": "int8", "label": "Int8"},
            {"value": "float32", "label": "Float32"},
        ],
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_device": {
        "label": "Device",
        "description": "Compute device for Whisper engine",
        "type": "select",
        "options": [
            {"value": "auto", "label": "Auto (recommended)"},
            {"value": "cuda", "label": "CUDA"},
            {"value": "cpu", "label": "CPU"},
        ],
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "partial_emission_interval": {
        "label": "Update Interval",
        "description": "How often partial transcription results are sent (seconds)",
        "type": "number",
        "range": [0.1, 2.0],
        "requires_reload": False,
        "category": "transcription",
    },
    "unload_before_swap": {
        "label": "Unload Before Swap",
        "description": "Free VRAM before loading new engine (for low-VRAM GPUs)",
        "type": "bool",
        "requires_reload": False,
        "category": "engine",
    },
}

# Keys that trigger engine reload when changed
RELOAD_KEYS = {k for k, v in SETTINGS_METADATA.items() if v.get("requires_reload")}

# Keys exposed via REST API (excludes server-internal settings)
API_KEYS = set(SETTINGS_METADATA.keys())


def get_settings_with_metadata(settings: Settings) -> dict[str, Any]:
    values = settings.model_dump()
    result = {}
    for key, meta in SETTINGS_METADATA.items():
        result[key] = {
            "value": values[key],
            **meta,
        }
    return result


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is not None:
        return _settings
    # Load from settings.json first, env vars override
    persisted = _load_settings_json()
    _settings = Settings(**persisted) if persisted else Settings()
    return _settings


def update_settings(patch: dict[str, Any]) -> Settings:
    global _settings
    current = get_settings()
    current_dict = current.model_dump()
    current_dict.update(patch)
    _settings = Settings(**current_dict)
    # Persist non-default values
    _persist_settings(_settings)
    return _settings


def _persist_settings(settings: Settings) -> None:
    defaults = Settings()
    default_dict = defaults.model_dump()
    current_dict = settings.model_dump()
    # Only persist values that differ from defaults
    diff: dict[str, Any] = {}
    for key in API_KEYS:
        if key in current_dict and current_dict[key] != default_dict.get(key):
            diff[key] = current_dict[key]
    try:
        SETTINGS_FILE.write_text(json.dumps(diff, indent=2) + "\n")
    except OSError as e:
        logger.error("Failed to write settings.json: %s", e)
