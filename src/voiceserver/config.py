"""Configuration management using pydantic-settings."""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_prefix="VOICESERVER_",
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # Server settings
    host: str = "0.0.0.0"
    port: int = 8765

    # Session limits
    max_sessions: int = 10
    start_timeout: float = 10.0  # Seconds to wait for start frame

    # Whisper model settings
    whisper_model: str = "large-v3-turbo"
    whisper_device: Literal["auto", "cpu", "cuda"] = "auto"
    whisper_compute_type: Literal["auto", "int8", "int8_float16", "int16", "float16", "float32"] = "auto"

    # Transcription settings
    partial_emission_interval: float = 0.5  # Seconds between partial emissions
    min_audio_for_transcription: float = 0.5  # Minimum seconds of audio before transcribing

    # Logging
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"


@lru_cache
def get_settings() -> Settings:
    """Get cached application settings."""
    return Settings()
