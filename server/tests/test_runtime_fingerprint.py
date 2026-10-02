"""Health response runtime identity contract for Electron process adoption."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import app as app_module
from transcription.contracts import ModelId, ModelInfo, Ready, Starting


def _health_endpoint():
    app = app_module.create_app()
    for route in app.routes:
        if getattr(route, "path", None) == "/health" and "GET" in route.methods:
            return route.endpoint
    raise AssertionError("GET /health route not found")


def _wire_health_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    *,
    status: object,
    settings: object,
    pack_id: str | None,
) -> None:
    class Runtime:
        def status(self):
            return status

    monkeypatch.setattr(
        app_module,
        "get_session_manager",
        lambda: SimpleNamespace(active_count=0, max_sessions=10),
    )
    monkeypatch.setattr(app_module, "get_model_runtime", lambda: Runtime())
    monkeypatch.setattr(app_module, "get_settings", lambda: settings)
    monkeypatch.setattr(app_module, "collect_diagnostics", lambda _settings: {"warnings": []})
    monkeypatch.setattr(app_module, "get_model_download_state", lambda: {"status": "missing"})
    monkeypatch.setattr(app_module, "registered_gpu_pack_id", lambda: pack_id)


@pytest.mark.asyncio
async def test_health_reports_runtime_fingerprint_from_ready_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = ModelInfo(
        model=ModelId("tiny"),
        device="cuda",
        compute_type="float16",
    )
    _wire_health_dependencies(
        monkeypatch,
        status=Ready(model=model),
        settings=SimpleNamespace(whisper_device="cpu", effective_whisper_config=None),
        pack_id="gpu-pack-v2-sha256",
    )
    monkeypatch.setenv("MURMUR_APP_BUILD_ID", "eve-build-2026.09")

    payload = await _health_endpoint()()

    assert payload["runtime"] == {
        "app_build": "eve-build-2026.09",
        "server_build": app_module.SERVER_VERSION,
        "pack_id": "gpu-pack-v2-sha256",
        "effective_device": "cuda",
    }
    assert "gpu_ready" not in payload["runtime"]


def test_health_pack_identity_does_not_claim_gpu_inference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _wire_health_dependencies(
        monkeypatch,
        status=Starting(),
        settings=SimpleNamespace(whisper_device="cpu", effective_whisper_config=None),
        pack_id="installed-pack-not-yet-used",
    )
    monkeypatch.delenv("MURMUR_APP_BUILD_ID", raising=False)

    payload = asyncio.run(_health_endpoint()())

    assert payload["runtime"] == {
        "app_build": None,
        "server_build": app_module.SERVER_VERSION,
        "pack_id": "installed-pack-not-yet-used",
        "effective_device": "cpu",
    }
    assert "gpu_ready" not in payload["runtime"]


def test_failed_engine_does_not_claim_settings_gpu_device() -> None:
    settings = SimpleNamespace(
        whisper_device="cuda",
        effective_whisper_config=SimpleNamespace(effective_device="cuda"),
    )

    fingerprint = app_module._runtime_fingerprint({"status": "error"}, settings)

    assert fingerprint["effective_device"] is None
