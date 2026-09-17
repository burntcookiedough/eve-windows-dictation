"""Public-seam regression coverage for the model-runtime caller cutover.

These tests intentionally exercise the server composition root, REST serializer,
settings transaction, processor lease, and WebSocket readiness seam.  They do
not reach into ``ModelRuntime`` implementation details.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

import app as app_module
import config
import transcription.processor as processor_module
from config import Settings
from transcription.contracts import (
    Failed,
    ModelId,
    ModelInfo,
    PreparationProgress,
    Preparing,
    PublicModelError,
    Ready,
    SessionId,
    TranscribeResult,
    WhisperConfig,
)
from transcription.factory import (
    model_info_to_engine_payload,
    runtime_accepts_sessions,
    runtime_status_to_engine_payload,
    whisper_config_from_settings,
)


@pytest.fixture(autouse=True)
def _isolate_settings_file(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config, "_settings", None)


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "engine": "whisper",
        "whisper_model": "medium",
        "whisper_device": "cpu",
        "whisper_compute_type": "int8",
        "whisper_language": "de",
        "whisper_beam_size": 3,
        "whisper_temperature": 0.2,
        "whisper_condition_on_previous_text": True,
        "whisper_without_timestamps": False,
        "whisper_vad_filter": True,
        "whisper_vad_min_silence_duration_ms": 900,
        "whisper_vad_speech_pad_ms": 320,
        "whisper_vad_threshold": 0.65,
    }
    values.update(overrides)
    return Settings(**values)


def _info(model: str = "medium") -> ModelInfo:
    return ModelInfo(
        model=ModelId(model),
        repo_id="Systran/faster-whisper-medium",
        model_path="C:/cache/medium",
        size_gb=1.4,
        languages=("en", "de"),
        device="cuda",
        compute_type="float16",
        cuda_active=True,
        load_time_s=1.25,
        supports_hotwords=True,
        gpu_name="Test GPU",
        gpu_vram_gb=8.0,
        estimated_max_duration_s=240,
        last_transcription_latency_s=0.03,
        vram_used_gb=2.2,
    )


def test_settings_map_to_complete_whisper_config() -> None:
    config_value = whisper_config_from_settings(_settings())

    assert config_value == WhisperConfig(
        model=ModelId("medium"),
        device="cpu",
        compute_type="int8",
        language="de",
        beam_size=3,
        temperature=0.2,
        condition_on_previous_text=True,
        without_timestamps=False,
        vad_filter=True,
        vad_min_silence_duration_ms=900,
        vad_speech_pad_ms=320,
        vad_threshold=0.65,
    )


def test_model_status_serializer_preserves_engine_compatibility_and_telemetry() -> None:
    payload = model_info_to_engine_payload(_info())
    status = runtime_status_to_engine_payload(Ready(model=_info()))

    assert payload["id"] == "whisper"
    assert payload["name"] == "Faster-Whisper"
    assert payload["model"] == "medium"
    assert payload["model_size_gb"] == 1.4
    assert payload["size_gb"] == 1.4
    assert payload["gpu_name"] == "Test GPU"
    assert payload["gpu_vram_gb"] == 8.0
    assert payload["estimated_max_duration_s"] == 240
    assert status["current"] == "whisper"
    assert status["status"] == "ready"
    assert status["info"]["supports_hotwords"] is True


@pytest.mark.asyncio
async def test_settings_reload_persists_before_runtime_publication(monkeypatch: pytest.MonkeyPatch) -> None:
    committed = _settings(whisper_model="small", whisper_device="cpu", whisper_compute_type="int8")
    candidate = _settings(whisper_model="medium")
    events: list[str] = []

    class FakeRuntime:
        def status(self):
            return Ready(model=_info("small"))

        async def prepare_and_activate(self, config_value, *, persist, publish):
            events.append(f"prepare:{config_value.model}")
            persist()
            events.append(f"persisted:{config.get_settings().whisper_model}")
            publish()
            events.append(f"published:{config.get_settings().whisper_model}")

    monkeypatch.setattr(config, "_settings", committed)
    monkeypatch.setattr(app_module, "get_model_runtime", lambda: FakeRuntime())
    monkeypatch.setattr(app_module, "get_settings", config.get_settings)
    monkeypatch.setattr(app_module, "get_settings_with_metadata", lambda value: value.model_dump())
    monkeypatch.setattr(app_module, "get_session_manager", lambda: SimpleNamespace(active_count=0, max_sessions=10))

    await app_module._prepare_runtime_background(FakeRuntime(), candidate, commit_on_success=True)

    assert events == ["prepare:medium", "persisted:small", "published:medium"]
    assert config.get_settings() == candidate


@pytest.mark.asyncio
async def test_runtime_task_completion_consumes_and_logs_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged: list[tuple[str, object]] = []

    async def fail() -> None:
        raise RuntimeError("reload failed")

    monkeypatch.setattr(
        app_module.logger,
        "error",
        lambda message, *, exc_info: logged.append((message, exc_info)),
    )

    task = app_module._track_runtime_task(asyncio.create_task(fail()))
    with pytest.raises(RuntimeError, match="reload failed"):
        await task
    await asyncio.sleep(0)

    assert task not in app_module._runtime_tasks
    assert logged[0][0] == "Background model runtime operation failed"
    assert logged[0][1][1].args == ("reload failed",)


@pytest.mark.asyncio
async def test_processor_owns_idempotent_runtime_lease(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeSession:
        def __init__(self) -> None:
            self.closed = 0

        def transcribe(self, _audio, *, hotwords=None, options=None):
            return TranscribeResult(text="ok", confidence=1.0, last_speech_end=0.1)

        def finalize(self):
            return TranscribeResult(text="ok", confidence=1.0, last_speech_end=0.1)

        def close(self):
            self.closed += 1

    class FakeLease:
        def __init__(self, session):
            self.session = session
            self.closed = 0

        def close(self):
            self.closed += 1
            self.session.close()

    class FakeRuntime:
        def __init__(self):
            self.session = FakeSession()
            self.lease = FakeLease(self.session)

        def open_session(self, session_id):
            assert session_id == SessionId("session-1")
            return self.lease

    runtime = FakeRuntime()
    monkeypatch.setattr(processor_module, "get_model_runtime", lambda: runtime)
    monkeypatch.setattr(processor_module, "get_settings", lambda: SimpleNamespace(min_audio_for_transcription=0.1))
    context = SimpleNamespace(session_id="session-1", audio_buffer=SimpleNamespace(), hotwords=None)

    processor = processor_module.TranscriptionProcessor(context)
    processor.close()
    processor.close()

    assert runtime.lease.closed == 1
    assert runtime.session.closed == 1


@pytest.mark.asyncio
async def test_lifespan_awaits_runtime_shutdown(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[str] = []

    class FakeRuntime:
        async def start(self):
            events.append("start")

    runtime = FakeRuntime()
    monkeypatch.setattr(app_module, "get_settings", lambda: _settings())
    monkeypatch.setattr(app_module, "init_model_runtime", lambda _settings: runtime)
    monkeypatch.setattr(
        app_module,
        "_schedule_runtime_start",
        lambda _runtime: events.append("scheduled"),
    )

    async def shutdown() -> None:
        events.append("shutdown")

    monkeypatch.setattr(app_module, "shutdown_model_runtime", shutdown)
    monkeypatch.setattr(app_module, "shutdown_executor", lambda: events.append("executor"))

    async with app_module.lifespan(SimpleNamespace()):
        events.append("yield")

    assert events == ["scheduled", "yield", "shutdown", "executor"]


def test_replacement_status_keeps_current_model_admissible() -> None:
    status = Preparing(current=_info("small"), candidate=ModelId("medium"))
    payload = runtime_status_to_engine_payload(status)

    assert payload["status"] == "loading"
    assert payload["current"] == "whisper"
    assert payload["info"]["model"] == "small"
    assert payload["pending"]["engine"] == "whisper"
    assert payload["pending"]["model"] == "medium"


def test_failed_replacement_keeps_current_model_admissible() -> None:
    status = Failed(
        current=_info("small"),
        candidate=ModelId("medium"),
        error=PublicModelError(code="preparation_failed", message="Preparation failed."),
    )

    assert runtime_accepts_sessions(status) is True
    assert runtime_status_to_engine_payload(status)["info"]["model"] == "small"
