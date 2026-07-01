"""Configuration management using pydantic-settings."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, ValidationError
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
    host: str = "127.0.0.1"
    port: int = 51717
    max_sessions: int = 10
    start_timeout: float = 10.0

    # Engine selection (Nemotron is default)
    engine: Literal["nemotron", "whisper"] = "nemotron"
    # Internal: whether engine choice should be treated as automatic/default
    # selection or an explicit user override.
    engine_preference_mode: Literal["auto", "manual"] = "auto"

    # Whisper settings
    whisper_model: str = "large-v3-turbo"
    whisper_device: Literal["auto", "cpu", "cuda"] = "auto"
    whisper_compute_type: Literal[
        "auto", "int8", "int8_float16", "int16", "float16", "float32"
    ] = "auto"
    whisper_language: str | None = "en"
    whisper_beam_size: int = Field(default=1, ge=1, le=10)
    whisper_temperature: float = Field(default=0.0, ge=0.0, le=1.0)
    whisper_condition_on_previous_text: bool = False
    whisper_without_timestamps: bool = True
    whisper_vad_filter: bool = True
    whisper_vad_min_silence_duration_ms: int = Field(default=500, ge=100, le=5000)
    whisper_vad_speech_pad_ms: int = Field(default=200, ge=0, le=2000)
    whisper_vad_threshold: float = Field(default=0.5, ge=0.0, le=1.0)

    # Nemotron settings
    nemotron_model: str = "nvidia/nemotron-speech-streaming-en-0.6b"
    nemotron_device: Literal["auto", "cpu", "cuda"] = "auto"

    # Transcription settings
    partial_emission_interval: float = Field(default=0.25, gt=0.0)
    min_audio_for_transcription: float = 0.15
    transcription_max_workers: int = Field(default=1, ge=1, le=4)
    allow_overlapping_inference: bool = False
    long_dictation_threshold_s: float = Field(default=30.0, gt=0.0)
    long_dictation_chunk_s: float = Field(default=25.0, gt=1.0)
    long_dictation_overlap_s: float = Field(default=0.75, ge=0.0, le=5.0)

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
    "whisper_language": {
        "label": "Language",
        "description": "Language code for Whisper. Use en for fastest English dictation.",
        "type": "text",
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_beam_size": {
        "label": "Beam Size",
        "description": "1 is fastest and best for low-latency dictation.",
        "type": "number",
        "range": [1, 10],
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_temperature": {
        "label": "Temperature",
        "description": "0 is deterministic and recommended for prompts and commands.",
        "type": "number",
        "range": [0, 1],
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_condition_on_previous_text": {
        "label": "Condition On Previous Text",
        "description": "Disable for independent push-to-talk dictation snippets.",
        "type": "bool",
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_without_timestamps": {
        "label": "Without Timestamps",
        "description": "Skip timestamp generation for lower latency.",
        "type": "bool",
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_vad_filter": {
        "label": "Voice Activity Detection",
        "description": "Filter non-speech audio before decoding.",
        "type": "bool",
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_vad_min_silence_duration_ms": {
        "label": "VAD Min Silence",
        "description": "Minimum silence in milliseconds before speech is split.",
        "type": "number",
        "range": [100, 5000],
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_vad_speech_pad_ms": {
        "label": "VAD Speech Pad",
        "description": "Milliseconds of padding around detected speech.",
        "type": "number",
        "range": [0, 2000],
        "requires_reload": True,
        "category": "engine",
        "visible_when": {"engine": "whisper"},
    },
    "whisper_vad_threshold": {
        "label": "VAD Threshold",
        "description": "Speech probability threshold for VAD.",
        "type": "number",
        "range": [0, 1],
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
    "transcription_max_workers": {
        "label": "Transcription Workers",
        "description": "Maximum local inference workers. 1 avoids overlapping GPU inference.",
        "type": "number",
        "range": [1, 4],
        "requires_reload": False,
        "category": "transcription",
    },
    "allow_overlapping_inference": {
        "label": "Allow Overlapping Inference",
        "description": "Permit concurrent inference calls on the same GPU.",
        "type": "bool",
        "requires_reload": False,
        "category": "transcription",
    },
    "long_dictation_threshold_s": {
        "label": "Long Dictation Threshold",
        "description": "Seconds before final transcription switches to chunked long dictation mode.",
        "type": "number",
        "range": [5, 120],
        "requires_reload": False,
        "category": "transcription",
    },
    "long_dictation_chunk_s": {
        "label": "Long Dictation Chunk",
        "description": "Target seconds per local batch chunk for long dictation.",
        "type": "number",
        "range": [5, 60],
        "requires_reload": False,
        "category": "transcription",
    },
    "long_dictation_overlap_s": {
        "label": "Long Dictation Overlap",
        "description": "Seconds of overlap between long dictation chunks for safer stitching.",
        "type": "number",
        "range": [0, 5],
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
    "engine_preference_mode": {
        "label": "Engine Selection Mode",
        "description": "Whether the engine was chosen automatically or manually overridden",
        "type": "select",
        "options": [
            {"value": "auto", "label": "Auto"},
            {"value": "manual", "label": "Manual"},
        ],
        "requires_reload": True,
        "category": "engine",
    },
}

# Keys that trigger engine reload when changed
RELOAD_KEYS = {k for k, v in SETTINGS_METADATA.items() if v.get("requires_reload")}

# Keys exposed via REST API (excludes server-internal settings)
API_KEYS = set(SETTINGS_METADATA.keys())
PERSISTED_INTERNAL_KEYS: set[str] = set()


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
    try:
        _settings = Settings(**persisted) if persisted else Settings()
    except ValidationError as e:
        logger.warning("Invalid settings.json values; falling back to defaults: %s", e)
        _settings = Settings()
    return _settings


def update_settings(patch: dict[str, Any]) -> Settings:
    global _settings
    current = get_settings()
    current_dict = current.model_dump()
    current_dict.update(patch)
    try:
        updated = Settings(**current_dict)
    except ValidationError as e:
        logger.warning("Rejected invalid settings update: %s", e)
        raise
    _settings = updated
    # Persist non-default values
    _persist_settings(_settings)
    return _settings


def _persist_settings(settings: Settings) -> None:
    defaults = Settings()
    default_dict = defaults.model_dump()
    current_dict = settings.model_dump()
    # Only persist values that differ from defaults
    diff: dict[str, Any] = {}
    for key in API_KEYS | PERSISTED_INTERNAL_KEYS:
        if key in current_dict and current_dict[key] != default_dict.get(key):
            diff[key] = current_dict[key]
    try:
        SETTINGS_FILE.write_text(json.dumps(diff, indent=2) + "\n")
    except OSError as e:
        logger.error("Failed to write settings.json: %s", e)
