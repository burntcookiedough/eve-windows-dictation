"""Behavioral tests for the raw legacy-settings migration boundary."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import config
import legacy_settings
from engine_compatibility import ComputeCapability, RuntimeCapabilities


LEGACY_NEMOTRON_MODEL = "nvidia/nemotron-speech-streaming-en-0.6b"


@pytest.fixture(autouse=True)
def _reset_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "_settings", None)
    monkeypatch.setattr(
        config,
        "get_runtime_capabilities",
        lambda: RuntimeCapabilities(
            whisper_cpu=ComputeCapability(frozenset({"int8", "float32"})),
            whisper_cuda=ComputeCapability(
                None, "CTranslate2 did not find a usable CUDA device."
            ),
        ),
    )
    yield
    config._settings = None


def test_known_legacy_nemotron_selection_maps_to_recommended_whisper() -> None:
    raw = {
        "engine": "nemotron",
        "nemotron_model": LEGACY_NEMOTRON_MODEL,
        "nemotron_device": "cuda",
        "whisper_model": "tiny",
        "whisper_language": "de",
        "partial_emission_interval": 0.5,
    }
    original = dict(raw)

    outcome = legacy_settings.migrate_raw_settings(raw)

    assert outcome.values["engine"] == "whisper"
    assert outcome.values["whisper_model"] == "large-v3-turbo"
    assert outcome.values["whisper_language"] == "de"
    assert outcome.values["partial_emission_interval"] == 0.5
    assert "nemotron_model" not in outcome.values
    assert "nemotron_device" not in outcome.values
    assert "engine_preference_mode" not in outcome.values
    assert "unload_before_swap" not in outcome.values
    assert outcome.migrated is True
    assert outcome.diagnostic is not None
    assert "large-v3-turbo" in outcome.diagnostic
    assert raw == original


def test_custom_legacy_model_is_not_interpreted_as_a_whisper_identifier() -> None:
    private_path = r"C:\Users\private-user\models\nemotron-custom"
    raw = {
        "engine": "nemotron",
        "nemotron_model": private_path,
        "nemotron_device": "cpu",
        "whisper_model": private_path,
        "whisper_device": "cpu",
    }

    outcome = legacy_settings.migrate_raw_settings(raw)

    assert outcome.values["engine"] == "whisper"
    assert outcome.values["whisper_model"] == "large-v3-turbo"
    assert private_path not in outcome.values.values()
    assert outcome.diagnostic is not None
    assert len(outcome.diagnostic) <= 200
    assert private_path not in outcome.diagnostic
    assert "private-user" not in outcome.diagnostic
    assert "custom" in outcome.diagnostic.casefold()


def test_invalid_legacy_selector_is_bounded_and_cannot_reset_other_values() -> None:
    raw = {
        "engine": {"provider": "nemotron", "model": "private"},
        "engine_preference_mode": "manual",
        "whisper_language": "pt",
        "partial_emission_interval": 0.4,
    }

    outcome = legacy_settings.migrate_raw_settings(raw)

    assert outcome.values["engine"] == "whisper"
    assert outcome.values["whisper_model"] == "large-v3-turbo"
    assert outcome.values["whisper_language"] == "pt"
    assert "engine_preference_mode" not in outcome.values
    assert outcome.diagnostic is not None
    assert "private" not in outcome.diagnostic
    assert len(outcome.diagnostic) <= 200


def test_stale_nemotron_device_is_removed_without_resetting_whisper_preferences() -> None:
    raw = {
        "engine": "whisper",
        "nemotron_device": "cuda",
        "unload_before_swap": True,
        "whisper_model": "medium",
        "whisper_language": "fr",
    }

    outcome = legacy_settings.migrate_raw_settings(raw)

    assert outcome.values == {
        "engine": "whisper",
        "whisper_model": "medium",
        "whisper_language": "fr",
    }
    assert outcome.migrated is True
    assert outcome.diagnostic is not None


def test_stale_custom_nemotron_model_does_not_override_explicit_whisper_model() -> None:
    raw = {
        "engine": "whisper",
        "nemotron_model": r"C:\Users\private-user\models\nemotron-custom",
        "whisper_model": "medium",
        "whisper_language": "fr",
    }

    outcome = legacy_settings.migrate_raw_settings(raw)

    assert outcome.values["engine"] == "whisper"
    assert outcome.values["whisper_model"] == "medium"
    assert outcome.values["whisper_language"] == "fr"
    assert "nemotron_model" not in outcome.values
    assert "unload_before_swap" not in outcome.values
    assert outcome.diagnostic is not None
    assert "private-user" not in outcome.diagnostic


@pytest.mark.parametrize(
    "legacy_model",
    [LEGACY_NEMOTRON_MODEL, r"C:\Users\private-user\models\nemotron-custom"],
)
def test_stale_nemotron_model_without_engine_preserves_explicit_whisper_model(
    legacy_model: str,
) -> None:
    outcome = legacy_settings.migrate_raw_settings(
        {
            "nemotron_model": legacy_model,
            "whisper_model": "medium",
            "whisper_language": "fr",
        }
    )

    assert outcome.values == {
        "engine": "whisper",
        "whisper_model": "medium",
        "whisper_language": "fr",
    }
    assert outcome.migrated is True
    assert outcome.diagnostic is not None


def test_non_mapping_source_is_ignored_without_exposing_input() -> None:
    outcome = legacy_settings.migrate_raw_settings(["not", "settings"])  # type: ignore[arg-type]

    assert outcome.values == {}
    assert outcome.migrated is False
    assert outcome.diagnostic is not None
    assert "['not', 'settings']" not in outcome.diagnostic


def test_persisted_legacy_settings_are_rewritten_atomically_and_keep_unrelated_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "nested" / "server-settings.json"
    settings_file.parent.mkdir()
    settings_file.write_text(
        json.dumps(
            {
                "engine": "nemotron",
                "nemotron_model": LEGACY_NEMOTRON_MODEL,
                "nemotron_device": "cpu",
                "unload_before_swap": True,
                "whisper_model": "tiny",
                "whisper_language": "es",
                "long_dictation_chunk_s": 18.0,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))

    settings = config.get_settings()

    assert settings.engine == "whisper"
    assert settings.whisper_model == "large-v3-turbo"
    assert settings.whisper_language == "es"
    assert settings.long_dictation_chunk_s == 18.0
    rewritten = json.loads(settings_file.read_text(encoding="utf-8"))
    assert rewritten["engine"] == "whisper"
    assert rewritten["whisper_model"] == "large-v3-turbo"
    assert rewritten["whisper_language"] == "es"
    assert rewritten["long_dictation_chunk_s"] == 18.0
    assert "nemotron_model" not in rewritten
    assert "nemotron_device" not in rewritten
    assert "unload_before_swap" not in rewritten
    assert list(settings_file.parent.glob(".*.tmp")) == []


def test_persisted_rewrite_failure_keeps_migrated_settings_in_memory_and_original_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    settings_file = tmp_path / "server-settings.json"
    original = {
        "engine": "nemotron",
        "nemotron_model": LEGACY_NEMOTRON_MODEL,
        "whisper_model": "small",
        "whisper_language": "it",
    }
    settings_file.write_text(json.dumps(original), encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))

    def fail_rewrite(*_args: object, **_kwargs: object) -> None:
        raise OSError("disk unavailable at C:\\Users\\private-user")

    monkeypatch.setattr(legacy_settings, "rewrite_settings_file", fail_rewrite)

    settings = config.get_settings()

    assert settings.engine == "whisper"
    assert settings.whisper_model == "large-v3-turbo"
    assert settings.whisper_language == "it"
    assert json.loads(settings_file.read_text(encoding="utf-8")) == original
    assert "private-user" not in caplog.text
    assert "continuing" in caplog.text.casefold()


def test_atomic_rewrite_cleans_temporary_file_after_serialization_failure(
    tmp_path: Path,
) -> None:
    settings_file = tmp_path / "server-settings.json"

    with pytest.raises(TypeError):
        legacy_settings.rewrite_settings_file(settings_file, {"invalid": object()})

    assert not settings_file.exists()
    assert list(tmp_path.glob(".*.tmp")) == []


def test_malformed_persisted_json_is_left_untouched_and_uses_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "server-settings.json"
    malformed = "{\"engine\":\"nemotron\""
    settings_file.write_text(malformed, encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))

    settings = config.get_settings()

    assert settings.engine == "whisper"
    assert settings_file.read_text(encoding="utf-8") == malformed


def test_legacy_environment_override_is_migrated_before_settings_validation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "server-settings.json"
    settings_file.write_text(
        json.dumps(
            {
                "engine": "whisper",
                "whisper_model": "small",
                "whisper_language": "en",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.setenv("MURMUR_ENGINE", "nemotron")
    monkeypatch.setenv(
        "MURMUR_NEMOTRON_MODEL", "org/nemotron-custom-without-a-whisper-alias"
    )
    monkeypatch.setenv("MURMUR_NEMOTRON_DEVICE", "cpu")
    monkeypatch.setenv("MURMUR_UNLOAD_BEFORE_SWAP", "true")
    monkeypatch.setenv("MURMUR_WHISPER_LANGUAGE", "ja")

    settings = config.get_settings()

    assert settings.engine == "whisper"
    assert settings.whisper_model == "large-v3-turbo"
    assert settings.whisper_language == "ja"
    assert not hasattr(settings, "nemotron_model")
    assert not hasattr(settings, "nemotron_device")
    assert json.loads(settings_file.read_text(encoding="utf-8"))["whisper_model"] == "small"


def test_persisted_whisper_settings_are_canonicalized_without_semantic_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "server-settings.json"
    raw = {
        "engine": "whisper",
        "engine_preference_mode": "auto",
        "unload_before_swap": False,
        "whisper_model": "medium",
        "whisper_language": "en",
    }
    settings_file.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))

    settings = config.get_settings()

    assert settings.engine == "whisper"
    assert settings.whisper_model == "medium"
    rewritten = json.loads(settings_file.read_text(encoding="utf-8"))
    assert rewritten == {
        "engine": "whisper",
        "whisper_model": "medium",
        "whisper_language": "en",
    }


def test_migrate_persisted_settings_is_the_documented_alias() -> None:
    outcome = legacy_settings.migrate_persisted_settings(
        {"engine": "nemotron", "whisper_language": "en"}
    )

    assert outcome.values["engine"] == "whisper"
    assert outcome.values["whisper_model"] == "large-v3-turbo"
