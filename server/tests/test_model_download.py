"""Model download cache detection and API payload tests."""

from __future__ import annotations

import asyncio

from config import Settings
import app as app_module
from fastapi import FastAPI
from transcription import model_download


class _DummyEngineStatus:
    current = "whisper"
    status = "ready"
    info = None
    pending = None
    message = None


class _DummyEngineManager:
    def get_status(self) -> _DummyEngineStatus:
        return _DummyEngineStatus()


class _DummySessionManager:
    active_count = 0
    max_sessions = 1


def _get_route_endpoint(app: FastAPI, path: str, method: str):
    for route in app.routes:
        if getattr(route, "path", None) == path and method in route.methods:
            return route.endpoint
    raise AssertionError(f"Route {method} {path} not found")


def test_is_repo_cached_detects_snapshot(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))

    snapshot_dir = (
        cache_dir
        / "models--Systran--faster-whisper-large-v3-turbo"
        / "snapshots"
        / "abc123"
    )
    snapshot_dir.mkdir(parents=True)

    assert model_download.is_repo_cached("Systran/faster-whisper-large-v3-turbo") is True


def test_is_repo_cached_returns_false_without_snapshot(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))

    assert model_download.is_repo_cached("Systran/faster-whisper-large-v3-turbo") is False


def test_health_includes_model_download(monkeypatch) -> None:
    monkeypatch.setattr(app_module, "get_session_manager", lambda: _DummySessionManager())
    monkeypatch.setattr(app_module, "get_engine_manager", lambda: _DummyEngineManager())
    monkeypatch.setattr(app_module, "get_settings", lambda: Settings())
    monkeypatch.setattr(app_module, "collect_diagnostics", lambda settings: {"warnings": []})

    model_download.update_model_download_state(
        model="large-v3-turbo",
        size_gb=1.5,
        status="downloading",
        cached=False,
        detail="download started",
    )

    app = app_module.create_app()
    endpoint = _get_route_endpoint(app, "/health", "GET")
    payload = asyncio.run(endpoint())

    assert payload["model_download"]["status"] == "downloading"
    assert payload["model_download"]["model"] == "large-v3-turbo"
