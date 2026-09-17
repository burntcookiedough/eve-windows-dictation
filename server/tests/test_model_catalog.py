"""Behavioral tests for the server-owned Faster-Whisper model catalog."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import app as app_module
import config
from config import Settings
from transcription.catalog import (
    FASTER_WHISPER_CATALOG,
    model_catalog_payload,
    model_setting_options,
)
from transcription.contracts import ModelId, ModelInfo, Ready


def _get_route_endpoint(app, path: str, method: str):
    for route in app.routes:
        if getattr(route, "path", None) == path and method in route.methods:
            return route.endpoint
    raise AssertionError(f"Route {method} {path} not found")


class _Runtime:
    def status(self):
        return Ready(model=ModelInfo(model=ModelId("large-v3-turbo")))


@pytest.fixture(autouse=True)
def _reset_settings(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config, "_settings", None)


def test_catalog_payload_is_typed_presentation_metadata_and_is_fresh() -> None:
    payload = model_catalog_payload()

    assert [item["model"] for item in payload] == [
        "large-v3-turbo",
        "large-v3",
        "medium",
        "small",
        "tiny",
    ]
    assert payload[0] == {
        "model": "large-v3-turbo",
        "label": "Recommended Multilingual",
        "summary": "A balanced multilingual option.",
        "repo_id": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
        "size_gb": 1.5,
        "language_label": "Multilingual",
        "languages": ["en", "de", "fr", "es", "it", "ja", "zh", "nl", "ko", "pt"],
        "supports_hotwords": True,
    }

    payload[0]["label"] = "mutated by caller"
    assert model_catalog_payload()[0]["label"] == "Recommended Multilingual"
    assert len(FASTER_WHISPER_CATALOG) == len(payload)


def test_settings_model_options_derive_from_the_same_catalog() -> None:
    options = model_setting_options()

    assert options == [
        {
            "value": item["model"],
            "label": item["label"],
            "description": item["summary"],
        }
        for item in model_catalog_payload()
    ]


@pytest.mark.asyncio
async def test_settings_endpoint_exposes_catalog_without_engine_discovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app_module, "get_model_runtime", lambda: _Runtime())
    monkeypatch.setattr(app_module, "get_settings", lambda: Settings())
    monkeypatch.setattr(app_module, "get_settings_with_metadata", lambda _settings: {})
    monkeypatch.setattr(
        app_module,
        "discover_engines",
        lambda: (_ for _ in ()).throw(AssertionError("new settings path must not discover engines")),
    )

    endpoint = _get_route_endpoint(app_module.create_app(), "/settings", "GET")
    response = await endpoint()

    assert response["model_catalog"] == model_catalog_payload()
    assert "available_engines" not in response


@pytest.mark.asyncio
async def test_settings_patch_keeps_catalog_when_legacy_client_fields_are_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app_module, "get_model_runtime", lambda: _Runtime())
    monkeypatch.setattr(app_module, "get_settings", lambda: Settings())
    monkeypatch.setattr(app_module, "get_settings_with_metadata", lambda _settings: {})
    monkeypatch.setattr(app_module, "commit_settings", lambda candidate: candidate)
    monkeypatch.setattr(
        app_module,
        "get_session_manager",
        lambda: SimpleNamespace(active_count=0, max_sessions=0),
    )

    endpoint = _get_route_endpoint(app_module.create_app(), "/settings", "PATCH")
    response = await endpoint({"partial_emission_interval": 0.5})

    assert response["model_catalog"] == model_catalog_payload()
