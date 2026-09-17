"""Contract tests for the Faster-Whisper-only server surface."""

from __future__ import annotations

from pathlib import Path
from typing import Literal, get_args, get_origin

import config
import engine_compatibility
import legacy_settings
from transcription.vram import estimate_max_duration_s


SERVER_SRC = Path(__file__).parents[1] / "src"


def test_settings_schema_exposes_only_the_supported_engine() -> None:
    engine_field = config.Settings.model_fields["engine"]

    assert get_origin(engine_field.annotation) is Literal
    assert get_args(engine_field.annotation) == ("whisper",)
    assert config.Settings().engine == "whisper"
    assert {"nemotron_model", "nemotron_device", "engine_preference_mode", "unload_before_swap"}.isdisjoint(
        config.Settings.model_fields
    )
    assert config.SETTINGS_METADATA["engine"]["options"] == [
        {
            "value": "whisper",
            "label": "Faster-Whisper",
            "description": "Batch retranscribe mode. 25+ languages.",
        }
    ]
    for removed in (
        "nemotron_model",
        "nemotron_device",
        "engine_preference_mode",
        "unload_before_swap",
    ):
        assert removed not in config.SETTINGS_METADATA
        assert removed not in config.RELOAD_KEYS
        assert removed not in config.API_KEYS


def test_legacy_nemotron_values_are_canonicalized_and_removed() -> None:
    outcome = legacy_settings.migrate_raw_settings(
        {
            "engine": "nemotron",
            "nemotron_model": "nvidia/nemotron-speech-streaming-en-0.6b",
            "nemotron_device": "cuda",
            "engine_preference_mode": "manual",
            "unload_before_swap": True,
            "whisper_language": "de",
        }
    )

    assert outcome.migrated is True
    assert outcome.values["engine"] == "whisper"
    assert outcome.values["whisper_model"] == legacy_settings.RECOMMENDED_WHISPER_MODEL
    assert outcome.values["whisper_language"] == "de"
    for removed in (
        "nemotron_model",
        "nemotron_device",
        "engine_preference_mode",
        "unload_before_swap",
    ):
        assert removed not in outcome.values


def test_stale_removed_fields_do_not_override_explicit_whisper_preferences() -> None:
    outcome = legacy_settings.migrate_raw_settings(
        {
            "engine": "whisper",
            "whisper_model": "small",
            "nemotron_model": "nvidia/nemotron-speech-streaming-en-0.6b",
            "nemotron_device": "cpu",
            "engine_preference_mode": "auto",
            "unload_before_swap": False,
        }
    )

    assert outcome.values["engine"] == "whisper"
    assert outcome.values["whisper_model"] == "small"
    for removed in (
        "nemotron_model",
        "nemotron_device",
        "engine_preference_mode",
        "unload_before_swap",
    ):
        assert removed not in outcome.values


def test_runtime_capabilities_model_only_probes_ctranslate2() -> None:
    capabilities = engine_compatibility.RuntimeCapabilities(
        whisper_cpu=engine_compatibility.ComputeCapability(frozenset({"int8"})),
        whisper_cuda=engine_compatibility.ComputeCapability(None, "CUDA unavailable"),
    )

    assert capabilities.whisper_device_for("auto") == "cpu"
    assert not hasattr(capabilities, "nemotron_cuda_available")


def test_whisper_vram_estimate_has_no_engine_selector() -> None:
    assert estimate_max_duration_s(8.0) == 88
    assert estimate_max_duration_s(None) is None


def test_server_logging_has_no_removed_model_stack_entries() -> None:
    app_source = (SERVER_SRC / "app.py").read_text(encoding="utf-8")

    assert '"faster_whisper"' in app_source
    for removed_logger in (
        "nemo_logger",
        "nemo",
        "nemo.collections",
        "torio",
        "torio._extension",
        "datasets",
        "numexpr",
        "nv_one_logger",
        "lhotse",
        "lhotse.cut",
        "lhotse.dataset",
        "matplotlib",
        "matplotlib.font_manager",
        "graphviz",
        "graphviz._tools",
    ):
        assert f'"{removed_logger}"' not in app_source
