"""Regression tests for portable settings and runtime lifecycle hardening."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest

import config
import pidfile
from config import Settings
from protocol.frames import ClosingReason
from session.context import SessionContext
from session.state import SessionState
import transcription.factory as factory
import transcription.processor as processor_module
from transcription.model_download import get_model_download_state
from transcription.processor import TranscriptionResult
from websocket.handler import _finalize_session, _silence_monitor_loop


@pytest.fixture(autouse=True)
def _reset_settings_cache(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(config, "_settings", None)
    yield
    config._settings = None


def test_environment_overrides_persisted_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(
        json.dumps({"whisper_model": "from-file", "whisper_device": "cuda"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.setenv("MURMUR_WHISPER_MODEL", "from-env")
    monkeypatch.setenv("MURMUR_WHISPER_DEVICE", "cpu")

    settings = config.get_settings()

    assert settings.whisper_model == "from-env"
    assert settings.whisper_device == "cpu"


def test_settings_persist_atomically_to_launcher_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "nested" / "settings.json"
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))

    updated = config.update_settings({"whisper_model": "small"})

    assert updated.whisper_model == "small"
    assert json.loads(settings_file.read_text(encoding="utf-8"))["whisper_model"] == "small"
    assert list(settings_file.parent.glob("*.tmp")) == []


def test_invalid_persisted_value_falls_back_to_builtin_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps({"whisper_device": "quantum"}), encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))

    settings = config.get_settings()

    assert settings.whisper_device == "auto"


def test_invalid_json_falls_back_to_builtin_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    settings_file.write_text("{not-json", encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))

    settings = config.get_settings()

    assert settings.engine == "nemotron"


def test_engine_discovery_uses_lightweight_top_level_specs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_find_spec(name: str):
        calls.append(name)
        return object() if name == "faster_whisper" else None

    before = set(sys.modules)
    monkeypatch.setattr(factory.importlib.util, "find_spec", fake_find_spec)

    discovered = {entry["id"]: entry for entry in factory.discover_engines()}

    assert calls == ["nemo", "faster_whisper"]
    assert discovered["nemotron"]["available"] is False
    assert discovered["whisper"]["available"] is True
    assert set(sys.modules) == before


def test_whisper_uncached_model_reports_downloading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import transcription.engines.whisper as whisper

    cache_status = SimpleNamespace(
        status="missing",
        detail="repository cache directory is missing",
        snapshot_path=None,
        repo_path="cache/repo",
        missing_files=["model.bin"],
        partial_files=[],
    )
    observed_during_load: list[tuple[str | None, str | None]] = []

    class FakeWhisperModel:
        def __init__(self, *args, **kwargs) -> None:
            state = get_model_download_state()
            observed_during_load.append(
                (state["status"], state["phase"]) if state else (None, None)
            )

    monkeypatch.setattr(whisper, "get_repo_cache_status", lambda _repo: cache_status)
    monkeypatch.setattr(whisper, "WhisperModel", FakeWhisperModel)
    monkeypatch.setattr(
        whisper, "download_model", lambda _repo, **_kwargs: "cache/snapshot"
    )
    monkeypatch.setattr(whisper, "_get_cuda_active", lambda _device: False)

    whisper.WhisperEngine(
        Settings(
            whisper_model="large-v3-turbo",
            whisper_device="cpu",
            whisper_compute_type="int8",
        )
    )

    assert observed_during_load == [("downloading", "loading")]
    assert get_model_download_state()["status"] == "ready"
    assert get_model_download_state()["phase"] == "ready"


@pytest.mark.parametrize(
    ("os_name", "platform", "environment", "expected_suffix"),
    [
        ("nt", "win32", {"LOCALAPPDATA": r"C:\Users\friend\AppData\Local"}, Path("murmur/server.pid")),
        ("posix", "darwin", {}, Path("Library/Application Support/murmur/server.pid")),
        ("posix", "linux", {}, Path(".local/share/murmur/server.pid")),
    ],
)
def test_pid_path_platform_matrix(
    os_name: str,
    platform: str,
    environment: dict[str, str],
    expected_suffix: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_environment = dict(environment)
    monkeypatch.setattr(pidfile, "os", SimpleNamespace(name=os_name, environ=fake_environment))
    monkeypatch.setattr(pidfile.sys, "platform", platform)
    monkeypatch.setattr(
        pidfile.Path, "home", classmethod(lambda cls: Path("C:/Users/friend"))
    )

    path = pidfile.get_pid_file_path()

    assert str(path).replace("\\", "/").endswith(str(expected_suffix).replace("\\", "/"))


def test_nemotron_session_creation_waits_for_active_inference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from transcription.engines.nemotron import NemotronEngine

    calls: list[str] = []
    model = SimpleNamespace(
        disable_cuda_graphs=lambda: calls.append("disable"),
        maybe_enable_cuda_graphs=lambda: calls.append("enable"),
    )
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(cuda=SimpleNamespace(empty_cache=lambda: calls.append("empty"))),
    )

    engine = NemotronEngine.__new__(NemotronEngine)
    engine._use_cuda = True
    engine._model = model
    engine._device = "cuda"
    engine._model_lock = threading.Lock()
    engine._model_lock.acquire()

    worker = threading.Thread(target=engine.create_session)
    worker.start()
    time.sleep(0.05)
    assert calls == []

    engine._model_lock.release()
    worker.join(timeout=1)

    assert not worker.is_alive()
    assert calls == ["disable", "empty", "enable"]


@pytest.mark.asyncio
async def test_engine_finishing_load_during_shutdown_is_discarded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()

    class FakeEngine:
        def __init__(self) -> None:
            self.shutdown_calls = 0

        def shutdown(self) -> None:
            self.shutdown_calls += 1

    fake_engine = FakeEngine()

    def create_engine(_settings: Settings) -> FakeEngine:
        started.set()
        assert release.wait(timeout=1)
        return fake_engine

    monkeypatch.setattr(factory, "_get_available_engine_ids", lambda: ["whisper"])
    monkeypatch.setattr(factory, "_create_engine", create_engine)
    manager = factory.EngineManager(Settings(engine="whisper"))

    swap_task = asyncio.create_task(manager.swap_engine(Settings(engine="whisper")))
    while not started.is_set():
        await asyncio.sleep(0.01)

    manager.shutdown()
    release.set()
    await swap_task

    assert manager._engine is None
    assert fake_engine.shutdown_calls == 1
    assert manager.get_status().status == "loading"


@pytest.mark.asyncio
async def test_executor_resize_does_not_block_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class SlowExecutor:
        def shutdown(self, *, wait: bool) -> None:
            assert wait is True
            time.sleep(0.15)

    monkeypatch.setattr(processor_module, "_executor", SlowExecutor())
    monkeypatch.setattr(processor_module, "_executor_workers", 1)
    monkeypatch.setattr(processor_module, "_executor_config_lock", None)

    resize_task = asyncio.create_task(processor_module.get_executor(2))
    heartbeat_count = 0
    while not resize_task.done():
        heartbeat_count += 1
        await asyncio.sleep(0.01)

    await resize_task
    assert heartbeat_count >= 5
    processor_module.shutdown_executor()


class _FinalProcessor:
    def __init__(self) -> None:
        self.calls = 0

    async def transcribe_final(self, progress_callback=None) -> TranscriptionResult:
        self.calls += 1
        await asyncio.sleep(0)
        return TranscriptionResult(
            text="hello",
            confidence=0.9,
            is_empty=False,
            transcription_time=0.01,
            audio_duration=1.0,
            last_speech_end=1.0,
        )


class _FinalSender:
    def __init__(self) -> None:
        self.finals = 0
        self.closings = 0

    async def send_status(self, *args, **kwargs) -> None:
        return

    async def send_final(self, *args, **kwargs) -> None:
        self.finals += 1

    async def send_closing(self, reason: ClosingReason) -> None:
        self.closings += 1


@pytest.mark.asyncio
async def test_concurrent_finalization_has_single_owner() -> None:
    context = SessionContext()
    context.state_machine.transition_to(SessionState.STARTED)
    processor = _FinalProcessor()
    sender = _FinalSender()

    await asyncio.gather(
        _finalize_session(sender, context, processor, ClosingReason.STOP_RECEIVED),
        _finalize_session(sender, context, processor, ClosingReason.SILENCE_TIMEOUT),
    )

    assert processor.calls == 1
    assert sender.finals == 1
    assert sender.closings == 1
    assert context.state_machine.state == SessionState.CLOSED


class _ClosingWebSocket:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_silence_finalization_closes_websocket() -> None:
    context = SessionContext(silence_timeout=0.01)
    context.state_machine.transition_to(SessionState.STARTED)
    context.audio_buffer.append(0, np.ones(160, dtype=np.int16))
    context.audio_buffer._last_audio_time = time.monotonic() - 1.0
    processor = _FinalProcessor()
    sender = _FinalSender()
    websocket = _ClosingWebSocket()

    await _silence_monitor_loop(websocket, sender, context, processor)

    assert websocket.closed is True
    assert context.state_machine.state == SessionState.CLOSED


class _FailingFinalSender(_FinalSender):
    async def send_final(self, *args, **kwargs) -> None:
        raise RuntimeError("socket write failed")


@pytest.mark.asyncio
async def test_silence_send_failure_still_closes_websocket() -> None:
    context = SessionContext(silence_timeout=0.01)
    context.state_machine.transition_to(SessionState.STARTED)
    context.audio_buffer.append(0, np.ones(160, dtype=np.int16))
    context.audio_buffer._last_audio_time = time.monotonic() - 1.0
    websocket = _ClosingWebSocket()

    await _silence_monitor_loop(
        websocket,
        _FailingFinalSender(),
        context,
        _FinalProcessor(),
    )

    assert websocket.closed is True
    assert context.state_machine.state == SessionState.CLOSED
