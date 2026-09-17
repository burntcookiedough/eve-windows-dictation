"""REST/settings transaction tests at the ModelRuntime composition seam."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app as server_app
import config
from config import Settings
from transcription.contracts import ModelId, ModelInfo, Preparing, Ready


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "engine": "whisper",
        "whisper_model": "small",
        "whisper_device": "cpu",
        "whisper_compute_type": "int8",
    }
    values.update(overrides)
    return Settings(**values)


def _info(model: str) -> ModelInfo:
    return ModelInfo(
        model=ModelId(model),
        device="cpu",
        compute_type="int8",
        languages=("en",),
    )


class _Runtime:
    def __init__(self, current: str = "small", failure: Exception | None = None) -> None:
        self.current = current
        self.failure = failure
        self.calls = []

    def status(self):
        return Ready(model=_info(self.current))

    async def prepare_and_activate(self, config_value, *, persist, publish) -> None:
        self.calls.append(config_value)
        if self.failure:
            raise self.failure
        persist()
        publish()
        self.current = str(config_value.model)


class _PreparingRuntime(_Runtime):
    def status(self):
        return Preparing(current=_info(self.current), candidate=ModelId("medium"))


@pytest.fixture(autouse=True)
def _reset_settings_state(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config, "_settings", None)
    yield
    config._settings = None


def _settings_handler():
    return next(
        route.endpoint
        for route in server_app.create_app().routes
        if getattr(route, "path", None) == "/settings" and "PATCH" in route.methods
    )


def test_candidate_validation_does_not_mutate_committed_memory_or_file() -> None:
    committed = config.commit_settings(_settings())
    settings_file = config.get_settings_file_path()
    before = settings_file.read_text(encoding="utf-8")

    candidate = config.build_settings_candidate({"whisper_model": "medium"})

    assert candidate.whisper_model == "medium"
    assert config.get_settings() is committed
    assert settings_file.read_text(encoding="utf-8") == before


def test_commit_persists_before_replacing_committed_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = config.commit_settings(_settings())
    candidate = config.build_settings_candidate({"whisper_model": "medium"})
    observed: list[Settings] = []

    def persist(_settings: Settings) -> None:
        observed.append(config.get_settings())

    monkeypatch.setattr(config, "_persist_settings", persist)
    config.commit_settings(candidate)

    assert observed == [committed]
    assert config.get_settings() is candidate


@pytest.mark.asyncio
async def test_reload_patch_schedules_candidate_while_committed_settings_stay_current(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = config.commit_settings(_settings())
    runtime = _Runtime()
    scheduled: list[tuple[object, Settings, bool]] = []
    monkeypatch.setattr(server_app, "get_model_runtime", lambda: runtime)
    monkeypatch.setattr(
        server_app,
        "_schedule_runtime_prepare",
        lambda runtime_value, candidate, *, commit_on_success: scheduled.append(
            (runtime_value, candidate, commit_on_success)
        ),
    )
    monkeypatch.setattr(server_app, "get_settings_with_metadata", lambda value: value.model_dump())
    monkeypatch.setattr(server_app, "get_session_manager", lambda: SimpleNamespace(active_count=0, max_sessions=10))

    response = await _settings_handler()({"whisper_model": "medium", "partial_emission_interval": 0.5})

    assert len(scheduled) == 1
    _, candidate, commit_on_success = scheduled[0]
    assert candidate.whisper_model == "medium"
    assert commit_on_success is True
    assert response["settings"]["whisper_model"] == "small"
    assert response["reload_started"] is True
    assert config.get_settings() is committed


@pytest.mark.asyncio
async def test_reload_reservation_rejects_a_second_patch_before_background_task_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = config.commit_settings(_settings())
    runtime = _Runtime()
    scheduled: list[Settings] = []
    monkeypatch.setattr(server_app, "get_model_runtime", lambda: runtime)
    def reserve_once(_runtime, candidate, *, commit_on_success):
        if scheduled:
            raise RuntimeError("Model preparation already in progress")
        scheduled.append(candidate)

    monkeypatch.setattr(server_app, "_schedule_runtime_prepare", reserve_once)
    monkeypatch.setattr(server_app, "get_settings_with_metadata", lambda value: value.model_dump())
    monkeypatch.setattr(
        server_app,
        "get_session_manager",
        lambda: SimpleNamespace(active_count=0, max_sessions=10),
    )
    handler = _settings_handler()

    await handler({"whisper_model": "medium"})
    with pytest.raises(HTTPException) as exc_info:
        await handler({"whisper_model": "large-v3"})

    assert exc_info.value.status_code == 409
    assert len(scheduled) == 1
    assert config.get_settings() is committed


@pytest.mark.asyncio
async def test_successful_reload_persists_then_publishes_complete_candidate() -> None:
    config.commit_settings(_settings())
    candidate = config.build_settings_candidate(
        {"whisper_model": "medium", "partial_emission_interval": 0.5}
    )
    runtime = _Runtime()

    await server_app._prepare_runtime_background(runtime, candidate, commit_on_success=True)

    assert runtime.calls[0].model == ModelId("medium")
    assert config.get_settings() == candidate


@pytest.mark.asyncio
async def test_failed_reload_keeps_runtime_and_committed_settings() -> None:
    committed = config.commit_settings(_settings())
    candidate = config.build_settings_candidate({"whisper_model": "medium"})
    runtime = _Runtime(failure=RuntimeError("preparation failed"))

    await server_app._prepare_runtime_background(runtime, candidate, commit_on_success=True)

    assert runtime.current == "small"
    assert config.get_settings() is committed


@pytest.mark.asyncio
async def test_persistence_failure_keeps_runtime_and_committed_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = config.commit_settings(_settings())
    candidate = config.build_settings_candidate({"whisper_model": "medium"})
    runtime = _Runtime()
    monkeypatch.setattr(
        config,
        "_persist_settings",
        lambda _settings: (_ for _ in ()).throw(OSError("disk unavailable")),
    )

    await server_app._prepare_runtime_background(runtime, candidate, commit_on_success=True)

    assert runtime.current == "small"
    assert config.get_settings() is committed


@pytest.mark.asyncio
async def test_pending_runtime_rejects_new_updates_without_overwriting_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = config.commit_settings(_settings())
    monkeypatch.setattr(server_app, "get_model_runtime", lambda: _PreparingRuntime())

    with pytest.raises(HTTPException) as exc_info:
        await _settings_handler()({"partial_emission_interval": 0.5})

    assert exc_info.value.status_code == 409
    assert config.get_settings() is committed


@pytest.mark.asyncio
async def test_non_reload_patch_commits_immediately(monkeypatch: pytest.MonkeyPatch) -> None:
    config.commit_settings(_settings())
    monkeypatch.setattr(server_app, "get_model_runtime", lambda: _Runtime())
    monkeypatch.setattr(server_app, "get_settings_with_metadata", lambda value: value.model_dump())
    monkeypatch.setattr(server_app, "get_session_manager", lambda: SimpleNamespace(active_count=0, max_sessions=10))

    response = await _settings_handler()({"partial_emission_interval": 0.5})

    assert response["reload_started"] is False
    assert response["settings"]["partial_emission_interval"] == 0.5
    assert config.get_settings().partial_emission_interval == 0.5


@pytest.mark.asyncio
async def test_non_reload_persistence_failure_keeps_committed_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    committed = config.commit_settings(_settings())
    monkeypatch.setattr(server_app, "get_model_runtime", lambda: _Runtime())
    monkeypatch.setattr(
        config,
        "_persist_settings",
        lambda _settings: (_ for _ in ()).throw(OSError("disk unavailable")),
    )

    with pytest.raises(HTTPException) as exc_info:
        await _settings_handler()({"partial_emission_interval": 0.5})

    assert exc_info.value.status_code == 500
    assert config.get_settings() is committed
