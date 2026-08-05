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


def _capabilities(
    *,
    cpu: frozenset[str] | None = frozenset({"int8", "float32"}),
    cuda: frozenset[str] | None = None,
    cpu_reason: str | None = None,
    cuda_reason: str | None = "CTranslate2 did not find a usable CUDA device.",
    nemotron_cuda: bool = False,
) -> RuntimeCapabilities:
    return RuntimeCapabilities(
        whisper_cpu=ComputeCapability(cpu, cpu_reason),
        whisper_cuda=ComputeCapability(cuda, cuda_reason),
        nemotron_cuda_available=nemotron_cuda,
        nemotron_cuda_reason=(
            None if nemotron_cuda else "PyTorch did not find a usable CUDA device."
        ),
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
        "nemotron_device": "cpu",
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
        nemotron_cuda=True,
    )

    compatibility.validate_engine_compatibility(
        whisper_device="cuda",
        whisper_compute_type="float16",
        nemotron_device="cuda",
        capabilities=capabilities,
    )

    unavailable = _capabilities()
    with pytest.raises(ValueError, match="CTranslate2 did not find a usable CUDA device"):
        compatibility.validate_engine_compatibility(
            whisper_device="cuda",
            whisper_compute_type="auto",
            nemotron_device="cpu",
            capabilities=unavailable,
        )
    with pytest.raises(ValueError, match="PyTorch did not find a usable CUDA device"):
        compatibility.validate_engine_compatibility(
            whisper_device="cpu",
            whisper_compute_type="auto",
            nemotron_device="cuda",
            capabilities=unavailable,
        )


def test_probe_failure_disables_explicit_precision_with_a_clean_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failed_runtime = SimpleNamespace(
        get_supported_compute_types=lambda _device: (_ for _ in ()).throw(RuntimeError()),
        get_cuda_device_count=lambda: 0,
    )
    monkeypatch.setattr(compatibility, "_load_ctranslate2", lambda: failed_runtime)
    monkeypatch.setattr(compatibility, "_load_torch", lambda: SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)))

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
            nemotron_device="cpu",
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


def test_invalid_patch_does_not_persist_or_schedule_a_swap(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    original = {"whisper_compute_type": "int8"}
    settings_file.write_text(json.dumps(original), encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: _capabilities())
    monkeypatch.setattr(
        server_app, "discover_engines", lambda: [{"id": "whisper", "available": True}]
    )
    swaps: list[object] = []
    monkeypatch.setattr(server_app, "_schedule_engine_swap", lambda *args: swaps.append(args))
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


def test_metadata_marks_the_same_cpu_precision_as_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: _capabilities())
    settings = config.Settings(
        whisper_device="cpu", whisper_compute_type="int8", nemotron_device="cpu"
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
