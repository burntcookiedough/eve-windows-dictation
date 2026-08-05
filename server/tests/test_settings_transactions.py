"""Regression tests for transactional reload settings updates."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app as server_app
import config
from config import Settings
from engine_compatibility import ComputeCapability, RuntimeCapabilities


class _EngineManager:
    def __init__(self, current: str = "whisper", failure: Exception | None = None) -> None:
        self.current = current
        self.failure = failure
        self.calls: list[Settings] = []

    async def swap_engine(self, settings: Settings, *, before_activate=None) -> None:
        self.calls.append(settings)
        if self.failure:
            raise self.failure
        if before_activate is not None:
            before_activate()
        self.current = settings.engine

    def get_status(self) -> SimpleNamespace:
        return SimpleNamespace(
            current=self.current, status="ready", info=None, pending=None, message=None
        )


@pytest.fixture(autouse=True)
def _reset_settings_state(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(
        config,
        "get_runtime_capabilities",
        lambda: RuntimeCapabilities(
            whisper_cpu=ComputeCapability(frozenset({"int8", "float32"})),
            whisper_cuda=ComputeCapability(
                None, "CTranslate2 did not find a usable CUDA device."
            ),
            nemotron_cuda_available=False,
            nemotron_cuda_reason="PyTorch did not find a usable CUDA device.",
        ),
    )
    monkeypatch.setattr(config, "_settings", None)
    server_app._settings_preparation_pending = False
    yield
    config._settings = None
    server_app._settings_preparation_pending = False


def _committed_settings() -> Settings:
    return config.commit_settings(
        Settings(
            engine="whisper",
            whisper_model="small",
            whisper_device="cpu",
            whisper_compute_type="int8",
        )
    )


def _settings_handler():
    return next(
        route.endpoint
        for route in server_app.create_app().routes
        if getattr(route, "path", None) == "/settings" and "PATCH" in route.methods
    )


def test_candidate_validation_does_not_mutate_committed_memory_or_file() -> None:
    committed = _committed_settings()
    settings_file = config.get_settings_file_path()
    before = settings_file.read_text(encoding="utf-8")

    candidate = config.build_settings_candidate({"whisper_model": "medium"})

    assert candidate.whisper_model == "medium"
    assert config.get_settings() is committed
    assert settings_file.read_text(encoding="utf-8") == before


def test_commit_persists_before_replacing_committed_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = _committed_settings()
    candidate = config.build_settings_candidate({"whisper_model": "medium"})
    observed_committed: list[Settings] = []

    def persist(_settings: Settings) -> None:
        observed_committed.append(config.get_settings())

    monkeypatch.setattr(config, "_persist_settings", persist)

    config.commit_settings(candidate)

    assert observed_committed == [committed]
    assert config.get_settings() is candidate


@pytest.mark.asyncio
async def test_reload_patch_schedules_candidate_while_committed_settings_stay_current(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = _committed_settings()
    settings_file = config.get_settings_file_path()
    before = settings_file.read_text(encoding="utf-8")
    manager = _EngineManager()
    scheduled: list[tuple[Settings, bool]] = []
    monkeypatch.setattr(
        server_app, "discover_engines", lambda: [{"id": "whisper", "available": True}]
    )
    monkeypatch.setattr(server_app, "get_engine_manager", lambda: manager)
    monkeypatch.setattr(
        server_app,
        "_schedule_engine_swap",
        lambda _manager, candidate, *, commit_on_success: scheduled.append(
            (candidate, commit_on_success)
        ),
    )

    response = await _settings_handler()(
        {"whisper_model": "medium", "partial_emission_interval": 0.5}
    )

    assert len(scheduled) == 1
    candidate, commit_on_success = scheduled[0]
    assert candidate.whisper_model == "medium"
    assert candidate.partial_emission_interval == 0.5
    assert commit_on_success is True
    assert response["settings"]["whisper_model"]["value"] == "small"
    assert response["settings"]["partial_emission_interval"]["value"] == 0.25
    assert response["reload_started"] is True
    assert config.get_settings() is committed
    assert settings_file.read_text(encoding="utf-8") == before


@pytest.mark.asyncio
async def test_successful_mixed_reload_commits_complete_candidate_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _committed_settings()
    candidate = config.build_settings_candidate(
        {"whisper_model": "medium", "partial_emission_interval": 0.5}
    )
    manager = _EngineManager()
    commits: list[Settings] = []
    original_commit = config.commit_settings

    def record_commit(settings: Settings) -> Settings:
        commits.append(settings)
        return original_commit(settings)

    monkeypatch.setattr(server_app, "commit_settings", record_commit)
    server_app._settings_preparation_pending = True

    await server_app._swap_engine_background(
        manager, candidate, commit_on_success=True
    )

    assert manager.calls == [candidate]
    assert commits == [candidate]
    assert config.get_settings() == candidate
    assert config.get_settings().partial_emission_interval == 0.5
    assert server_app._settings_preparation_pending is False


@pytest.mark.asyncio
async def test_failed_mixed_reload_commits_nothing_and_keeps_live_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = _committed_settings()
    candidate = config.build_settings_candidate(
        {"whisper_model": "medium", "partial_emission_interval": 0.5}
    )
    manager = _EngineManager(failure=RuntimeError("preparation failed"))
    commits: list[Settings] = []
    monkeypatch.setattr(server_app, "commit_settings", lambda settings: commits.append(settings))
    server_app._settings_preparation_pending = True

    await server_app._swap_engine_background(
        manager, candidate, commit_on_success=True
    )

    assert manager.current == "whisper"
    assert manager.calls == [candidate]
    assert commits == []
    assert config.get_settings() is committed
    assert config.get_settings().partial_emission_interval == 0.25
    assert server_app._settings_preparation_pending is False


@pytest.mark.asyncio
async def test_reload_persistence_failure_keeps_engine_and_committed_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = _committed_settings()
    settings_file = config.get_settings_file_path()
    before = settings_file.read_text(encoding="utf-8")
    candidate = config.build_settings_candidate({"whisper_model": "medium"})
    manager = _EngineManager()
    monkeypatch.setattr(config, "_persist_settings", lambda _settings: (_ for _ in ()).throw(OSError("disk unavailable")))
    server_app._settings_preparation_pending = True

    await server_app._swap_engine_background(
        manager, candidate, commit_on_success=True
    )

    assert manager.current == "whisper"
    assert config.get_settings() is committed
    assert settings_file.read_text(encoding="utf-8") == before
    assert server_app._settings_preparation_pending is False


@pytest.mark.asyncio
async def test_pending_reload_rejects_new_updates_without_overwriting_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = _committed_settings()
    monkeypatch.setattr(
        server_app, "discover_engines", lambda: [{"id": "whisper", "available": True}]
    )
    server_app._settings_preparation_pending = True

    with pytest.raises(HTTPException) as exc_info:
        await _settings_handler()({"partial_emission_interval": 0.5})

    assert exc_info.value.status_code == 409
    assert config.get_settings() is committed
    assert config.get_settings().partial_emission_interval == 0.25


@pytest.mark.asyncio
async def test_non_reload_patch_commits_immediately(monkeypatch: pytest.MonkeyPatch) -> None:
    _committed_settings()
    manager = _EngineManager()
    monkeypatch.setattr(
        server_app, "discover_engines", lambda: [{"id": "whisper", "available": True}]
    )
    monkeypatch.setattr(server_app, "get_engine_manager", lambda: manager)

    response = await _settings_handler()({"partial_emission_interval": 0.5})

    assert response["reload_started"] is False
    assert response["settings"]["partial_emission_interval"]["value"] == 0.5
    assert config.get_settings().partial_emission_interval == 0.5


@pytest.mark.asyncio
async def test_non_reload_persistence_failure_keeps_committed_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = _committed_settings()
    settings_file = config.get_settings_file_path()
    before = settings_file.read_text(encoding="utf-8")
    monkeypatch.setattr(
        server_app, "discover_engines", lambda: [{"id": "whisper", "available": True}]
    )
    monkeypatch.setattr(server_app, "get_engine_manager", lambda: _EngineManager())
    monkeypatch.setattr(config, "_persist_settings", lambda _settings: (_ for _ in ()).throw(OSError("disk unavailable")))

    with pytest.raises(HTTPException) as exc_info:
        await _settings_handler()({"partial_emission_interval": 0.5})

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Could not save settings. Please try again."
    assert config.get_settings() is committed
    assert settings_file.read_text(encoding="utf-8") == before
