"""Regression coverage for runtime-derived engine compatibility."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import app as server_app
import config
import engine_compatibility as compatibility
from engine_compatibility import ComputeCapability, RuntimeCapabilities
from transcription.contracts import ModelId, ModelInfo, Ready
from transcription.factory import whisper_config_from_settings


def _capabilities(
    *,
    cpu: frozenset[str] | None = frozenset({"int8", "float32"}),
    cuda: frozenset[str] | None = None,
    cpu_reason: str | None = None,
    cuda_reason: str | None = "CTranslate2 did not find a usable CUDA device.",
) -> RuntimeCapabilities:
    return RuntimeCapabilities(
        whisper_cpu=ComputeCapability(cpu, cpu_reason),
        whisper_cuda=ComputeCapability(cuda, cuda_reason),
    )


@pytest.fixture(autouse=True)
def _reset_settings_cache(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(config, "_settings", None)
    yield
    config._settings = None


@pytest.mark.parametrize(
    ("compute_type", "valid"),
    [
        ("auto", True),
        ("int8", True),
        ("float32", True),
        ("float16", False),
        ("int8_float16", False),
    ],
)
def test_cpu_precision_uses_ctranslate2_capabilities(
    compute_type: str, valid: bool
) -> None:
    capabilities = _capabilities()
    kwargs = {
        "whisper_device": "cpu",
        "whisper_compute_type": compute_type,
        "capabilities": capabilities,
    }

    if valid:
        compatibility.validate_engine_compatibility(**kwargs)
    else:
        with pytest.raises(ValueError, match="not supported on cpu"):
            compatibility.validate_engine_compatibility(**kwargs)


def test_cuda_device_and_precision_follow_available_capabilities() -> None:
    capabilities = _capabilities(
        cuda=frozenset({"int8", "float16", "int8_float16", "float32"}),
        cuda_reason=None,
    )

    compatibility.validate_engine_compatibility(
        whisper_device="cuda",
        whisper_compute_type="float16",
        capabilities=capabilities,
    )

    unavailable = _capabilities()
    with pytest.raises(ValueError, match="CTranslate2 did not find a usable CUDA device"):
        compatibility.validate_engine_compatibility(
            whisper_device="cuda",
            whisper_compute_type="auto",
            capabilities=unavailable,
        )


def test_unavailable_cuda_and_precision_resolve_to_cpu_without_changing_request() -> None:
    effective = compatibility.resolve_effective_whisper_config(
        whisper_device="cuda",
        whisper_compute_type="float16",
        capabilities=_capabilities(),
    )

    assert effective.requested_device == "cuda"
    assert effective.requested_compute_type == "float16"
    assert effective.effective_device == "cpu"
    assert effective.effective_compute_type == "auto"
    assert "CUDA" in (effective.unavailable_reason or "")
    assert "float16 is not supported on cpu" in (effective.unavailable_reason or "")


def test_packaged_cpu_build_ignores_system_cuda_without_a_validated_pack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MURMUR_APP_BUILD_ID", "0.8.2-alpha.5")
    monkeypatch.delenv("MURMUR_GPU_RUNTIME_DIR", raising=False)
    fake_runtime = SimpleNamespace(
        get_supported_compute_types=lambda device: {"int8", "float32"},
        get_cuda_device_count=lambda: (_ for _ in ()).throw(
            AssertionError("CPU build must not probe system CUDA")
        ),
    )
    monkeypatch.setattr(compatibility, "_load_ctranslate2", lambda: fake_runtime)

    capabilities = compatibility.get_runtime_capabilities()

    assert capabilities.whisper_cpu.compute_types == frozenset({"int8", "float32"})
    assert not capabilities.whisper_cuda_available
    assert capabilities.whisper_cuda.reason == "The optional GPU runtime is not installed."


def test_probe_failure_disables_explicit_precision_with_a_clean_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failed_runtime = SimpleNamespace(
        get_supported_compute_types=lambda _device: (_ for _ in ()).throw(RuntimeError()),
        get_cuda_device_count=lambda: 0,
    )
    monkeypatch.setattr(compatibility, "_load_ctranslate2", lambda: failed_runtime)
    capabilities = compatibility.get_runtime_capabilities()
    disabled, reason = compatibility.option_compatibility(
        "whisper_compute_type", "int8", capabilities, SimpleNamespace(whisper_device="cpu")
    )

    assert disabled is True
    assert reason == "CTranslate2 capability check failed for this device."
    with pytest.raises(ValueError, match="CTranslate2 capability check failed"):
        compatibility.validate_engine_compatibility(
            whisper_device="cpu",
            whisper_compute_type="int8",
            capabilities=capabilities,
        )


def test_whisper_language_normalizes_blank_and_rejects_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        compatibility, "get_whisper_language_codes", lambda: frozenset({"en", "de"})
    )

    assert compatibility.normalize_whisper_language(" En ") == "en"
    assert compatibility.normalize_whisper_language("   ") is None
    with pytest.raises(ValueError, match="Unsupported Whisper language code"):
        compatibility.normalize_whisper_language("english")


def test_whisper_language_rejects_non_string_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: _capabilities())

    with pytest.raises(ValidationError, match="Whisper language must be a string or null"):
        config.Settings(whisper_language=123)


def test_legacy_int16_is_narrowly_migrated_without_resetting_other_settings(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(
        json.dumps({"whisper_compute_type": "int16", "whisper_model": "tiny"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: _capabilities())

    settings = config.get_settings()

    assert settings.whisper_compute_type == "auto"
    assert settings.whisper_model == "tiny"


def test_unavailable_cuda_request_survives_load_and_unrelated_update(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    original = {
        "whisper_device": "cuda",
        "whisper_compute_type": "float16",
        "whisper_model": "tiny",
        "whisper_beam_size": 7,
        "log_level": "DEBUG",
    }
    settings_file.write_text(json.dumps(original), encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: _capabilities())

    loaded = config.get_settings()

    assert loaded.whisper_device == "cpu"
    assert loaded.whisper_compute_type == "auto"
    assert loaded.model_dump()["whisper_device"] == "cuda"
    assert loaded.model_dump()["whisper_compute_type"] == "float16"
    assert loaded.effective_whisper_config is not None
    assert "float16 is not supported on cpu" in (
        loaded.effective_whisper_config.unavailable_reason or ""
    )
    runtime_config = whisper_config_from_settings(loaded)
    assert runtime_config.device == "cpu"
    assert runtime_config.compute_type == "auto"
    metadata = config.get_settings_with_metadata(loaded)
    assert metadata["whisper_device"]["value"] == "cuda"
    assert metadata["whisper_compute_type"]["value"] == "float16"

    candidate = config.build_settings_candidate({"whisper_beam_size": 3})
    config.commit_settings(candidate)

    persisted = json.loads(settings_file.read_text(encoding="utf-8"))
    assert persisted == {
        "whisper_device": "cuda",
        "whisper_compute_type": "float16",
        "whisper_model": "tiny",
        "whisper_beam_size": 3,
        "log_level": "DEBUG",
    }
    assert candidate.whisper_device == "cpu"
    assert candidate.whisper_compute_type == "auto"


def test_invalid_patch_does_not_persist_or_schedule_a_swap(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    original = {"whisper_compute_type": "int8"}
    settings_file.write_text(json.dumps(original), encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: _capabilities())
    swaps: list[object] = []
    class ReadyRuntime:
        def status(self):
            return Ready(model=ModelInfo(model=ModelId("tiny"), device="cpu", compute_type="int8"))

    monkeypatch.setattr(server_app, "get_model_runtime", lambda: ReadyRuntime())
    monkeypatch.setattr(server_app, "_schedule_runtime_prepare", lambda *args, **kwargs: swaps.append((args, kwargs)))
    handler = next(
        route.endpoint
        for route in server_app.create_app().routes
        if getattr(route, "path", None) == "/settings" and "PATCH" in route.methods
    )

    with pytest.raises(HTTPException) as exc_info:
        import asyncio

        asyncio.run(handler({"whisper_compute_type": "float16"}))

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Whisper precision float16 is not supported on cpu."
    assert config.get_settings().whisper_compute_type == "int8"
    assert json.loads(settings_file.read_text(encoding="utf-8")) == original
    assert swaps == []


def test_unavailable_cuda_patch_is_rejected_without_erasing_saved_preferences(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    original = {"whisper_model": "tiny", "whisper_beam_size": 7, "log_level": "DEBUG"}
    settings_file.write_text(json.dumps(original), encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: _capabilities())

    class ReadyRuntime:
        def status(self):
            return Ready(model=ModelInfo(model=ModelId("tiny"), device="cpu", compute_type="int8"))

    monkeypatch.setattr(server_app, "get_model_runtime", lambda: ReadyRuntime())
    handler = next(
        route.endpoint
        for route in server_app.create_app().routes
        if getattr(route, "path", None) == "/settings" and "PATCH" in route.methods
    )

    with pytest.raises(HTTPException) as exc_info:
        import asyncio

        asyncio.run(handler({"whisper_device": "cuda"}))

    assert exc_info.value.status_code == 400
    assert "CTranslate2 did not find a usable CUDA device" in str(exc_info.value.detail)
    assert json.loads(settings_file.read_text(encoding="utf-8")) == original
    assert config.get_settings().whisper_beam_size == 7


def test_metadata_marks_the_same_cpu_precision_as_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: _capabilities())
    settings = config.Settings(
        whisper_device="cpu", whisper_compute_type="int8"
    )

    metadata = config.get_settings_with_metadata(settings)
    float16 = next(
        option
        for option in metadata["whisper_compute_type"]["options"]
        if option["value"] == "float16"
    )

    assert float16 == {
        "value": "float16",
        "label": "Float16",
        "disabled": True,
        "reason": "Not supported by CTranslate2 on cpu.",
        "device_compatibility": {
            "auto": {
                "disabled": True,
                "reason": "Not supported by CTranslate2 on cpu.",
            },
            "cpu": {
                "disabled": True,
                "reason": "Not supported by CTranslate2 on cpu.",
            },
            "cuda": {
                "disabled": True,
                "reason": "CTranslate2 did not find a usable CUDA device.",
            },
        },
    }


def test_hidden_legacy_int16_is_rejected_for_new_updates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: _capabilities())

    with pytest.raises(ValidationError):
        config.update_settings({"whisper_compute_type": "int16"})
