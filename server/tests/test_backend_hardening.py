"""Regression tests for portable settings and runtime lifecycle hardening."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path
import sys
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


def test_unrelated_patch_preserves_model_shadowed_by_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    settings_file.write_text('{"whisper_model":"small"}', encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.setenv("MURMUR_WHISPER_MODEL", "large-v3-turbo")

    assert config.get_settings().whisper_model == "large-v3-turbo"
    config.update_settings({"partial_emission_interval": 0.5})
    assert json.loads(settings_file.read_text(encoding="utf-8")) == {
        "whisper_model": "small",
        "partial_emission_interval": 0.5,
    }

    # Choosing the built-in default explicitly should clear the old choice.
    config.update_settings({"whisper_model": "large-v3-turbo"})
    assert json.loads(settings_file.read_text(encoding="utf-8")) == {
        "partial_emission_interval": 0.5,
    }


def test_unrelated_patch_does_not_persist_environment_only_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    settings_file.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.setenv("MURMUR_WHISPER_MODEL", "small")

    assert config.get_settings().whisper_model == "small"
    config.update_settings({"partial_emission_interval": 0.5})

    persisted = json.loads(settings_file.read_text(encoding="utf-8"))
    assert "whisper_model" not in persisted
    assert persisted["partial_emission_interval"] == 0.5


def test_unrelated_patch_preserves_model_shadowed_by_dotenv(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_file = tmp_path / "settings.json"
    settings_file.write_text('{"whisper_model":"small"}', encoding="utf-8")
    (tmp_path / ".env").write_text(
        "MURMUR_WHISPER_MODEL=large-v3-turbo\n", encoding="utf-8"
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MURMUR_SETTINGS_FILE", str(settings_file))
    monkeypatch.delenv("MURMUR_WHISPER_MODEL", raising=False)

    assert config.get_settings().whisper_model == "large-v3-turbo"
    config.update_settings({"partial_emission_interval": 0.5})
    assert json.loads(settings_file.read_text(encoding="utf-8")) == {
        "whisper_model": "small",
        "partial_emission_interval": 0.5,
    }


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

    assert settings.engine == "whisper"


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

    assert calls == ["faster_whisper"]
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
        whisper, "snapshot_download", lambda _repo, **_kwargs: "cache/snapshot"
    )
    monkeypatch.setattr(whisper, "_get_cuda_active", lambda _device, _model: False)

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
    ("os_name", "platform", "local_app_data", "root_suffix"),
    [
        ("nt", "win32", True, "local-data"),
        ("nt", "win32", False, "home/AppData/Local"),
        ("posix", "darwin", False, "home/Library/Application Support"),
        ("posix", "linux", False, "home/.local/share"),
    ],
)
@pytest.mark.parametrize("override", [None, ""])
def test_pid_path_platform_matrix(
    os_name: str,
    platform: str,
    local_app_data: bool,
    root_suffix: str,
    override: str | None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fallback operations share one Eve path and leave valid legacy state untouched."""
    environment = {"LOCALAPPDATA": str(tmp_path / "local-data")} if local_app_data else {}
    if override is not None:
        environment["MURMUR_PID_FILE"] = override
    monkeypatch.setattr(pidfile, "os", SimpleNamespace(name=os_name, environ=environment))
    monkeypatch.setattr(pidfile, "sys", SimpleNamespace(platform=platform))
    monkeypatch.setattr(pidfile.Path, "home", classmethod(lambda cls: tmp_path / "home"))
    root = tmp_path / root_suffix
    expected = root / "Eve" / "standalone" / "server.pid"
    legacy = root / "murmur"
    legacy.mkdir(parents=True)
    sentinels = {"server.pid": '{"pid": 999, "port": 9999, "startedAt": 1}',
                 "sentinel.txt": "synthetic legacy sentinel"}
    for name, contents in sentinels.items():
        (legacy / name).write_text(contents, encoding="utf-8")

    assert pidfile.get_pid_file_path() == expected
    # Neither read nor cleanup adopts a valid legacy PID when the new file is absent.
    assert pidfile.read_pid_file() is None
    pidfile.remove_pid_file()
    monkeypatch.setattr(pidfile.time, "time", lambda: 1234.567)
    pidfile.write_pid_file(123, 4567)
    data = {"pid": 123, "port": 4567, "startedAt": 1234567}
    assert json.loads(expected.read_text(encoding="utf-8")) == data
    assert pidfile.read_pid_file() == data
    pidfile.remove_pid_file()
    pidfile.remove_pid_file()
    assert not expected.exists()
    assert {p.name: p.read_text(encoding="utf-8") for p in legacy.iterdir()} == sentinels


@pytest.mark.parametrize("os_name,platform", [("nt", "win32"), ("posix", "darwin"), ("posix", "linux")])
@pytest.mark.parametrize("override", ["relative/server.pid", "~/literal/server.pid", " spaced /server.pid"])
def test_pid_override_preserves_path_semantics(
    os_name: str, platform: str, override: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Explicit launcher paths take precedence without expansion or trimming."""
    monkeypatch.setattr(pidfile, "os", SimpleNamespace(name=os_name, environ={
        "MURMUR_PID_FILE": override, "LOCALAPPDATA": "unused"
    }))
    monkeypatch.setattr(pidfile, "sys", SimpleNamespace(platform=platform))
    assert pidfile.get_pid_file_path() == Path(override)


def test_pid_override_write_read_remove(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """All PID operations honor the same exact launcher-provided path and JSON."""
    target = tmp_path / "launcher-profile" / "server.pid"
    monkeypatch.setenv("MURMUR_PID_FILE", str(target))
    monkeypatch.setattr(pidfile.time, "time", lambda: 1234.567)
    pidfile.write_pid_file(123, 4567)
    assert pidfile.get_pid_file_path() == target
    assert pidfile.read_pid_file() == {"pid": 123, "port": 4567, "startedAt": 1234567}
    assert json.loads(target.read_text(encoding="utf-8")) == pidfile.read_pid_file()
    pidfile.remove_pid_file()
    pidfile.remove_pid_file()
    assert not target.exists()


@pytest.mark.parametrize("contents", ["{invalid-json", '{"pid": 123, "port": 4567}'])
def test_pid_invalid_json_remains_unreadable(
    contents: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Malformed or incomplete JSON stays unreadable but remains safe to remove."""
    target = tmp_path / "server.pid"
    monkeypatch.setenv("MURMUR_PID_FILE", str(target))
    target.write_text(contents, encoding="utf-8")
    assert pidfile.read_pid_file() is None
    pidfile.remove_pid_file()
    assert not target.exists()


@pytest.mark.parametrize("override", [False, True])
@pytest.mark.parametrize("failure", [False, True])
@pytest.mark.parametrize("port", [0, 8765])
def test_server_exit_cleans_resolved_pid(
    override: bool, failure: bool, port: int, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Normal and failed serving runs clean both override and fallback PID state."""
    import main as server_main
    import uvicorn

    monkeypatch.delenv("MURMUR_PID_FILE", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(pidfile.Path, "home", classmethod(lambda cls: tmp_path))
    if override:
        monkeypatch.setenv("MURMUR_PID_FILE", str(tmp_path / "launcher" / "server.pid"))
    target = pidfile.get_pid_file_path()
    monkeypatch.setattr(server_main, "get_settings", lambda: SimpleNamespace(
        host="127.0.0.1", port=port, log_level="INFO", log_binary=False
    ))
    monkeypatch.setattr(server_main, "configure_logging", lambda _level: None)
    callbacks = []
    monkeypatch.setattr(pidfile.atexit, "register", callbacks.append)

    def run(*args, **kwargs):
        """Observe live PID state at the serving boundary before return or failure."""
        data = pidfile.read_pid_file()
        assert data is not None
        assert data["pid"] == server_main.os.getpid()
        assert isinstance(data["startedAt"], int)
        if port == 0:
            assert data["port"] == kwargs["sockets"][0].getsockname()[1] > 0
        else:
            assert data["port"] == port
        assert target.exists()
        if failure:
            raise RuntimeError("synthetic uvicorn failure")

    monkeypatch.setattr(uvicorn, "run", run)
    monkeypatch.setattr(uvicorn.Server, "run", run)
    if failure:
        with pytest.raises(RuntimeError, match="synthetic uvicorn failure"):
            server_main.main()
    else:
        server_main.main()
    assert not target.exists()
    assert callbacks == [pidfile.remove_pid_file]
    # Exercise the registered exit hook on real state, including duplicate cleanup.
    pidfile.write_pid_file(123, 4567)
    callbacks[0]()
    callbacks[0]()
    assert not target.exists()


@pytest.mark.parametrize("launch", ["script", "cli"])
@pytest.mark.parametrize("override", [False, True])
@pytest.mark.parametrize("failure", [False, True])
def test_standalone_launch_command_cleanup(
    launch: str, override: bool, failure: bool, tmp_path: Path
) -> None:
    """Real script and CLI processes remove their isolated PID on success or failure."""
    # Stub only the serving boundary: exercise the real command, resolver and exit.
    (tmp_path / "uvicorn.py").write_text(
        "import os\n"
        "import pidfile\n"
        "def run(*args, **kwargs):\n"
        "    data = pidfile.read_pid_file()\n"
        "    assert data['pid'] == os.getpid()\n"
        "    assert data['port'] == 8765\n"
        "    assert isinstance(data['startedAt'], int)\n"
        "    if os.environ['PID_TEST_FAILURE'] == '1':\n"
        "        raise RuntimeError('synthetic serving failure')\n",
        encoding="utf-8",
    )
    environment = {key: value for key, value in os.environ.items()
                   if not key.upper().startswith("MURMUR_")}
    environment.update({
        "PYTHONPATH": str(tmp_path),
        "LOCALAPPDATA": str(tmp_path),
        "HOME": str(tmp_path),
        "USERPROFILE": str(tmp_path),
        "MURMUR_SETTINGS_FILE": str(tmp_path / "absent-settings.json"),
        "MURMUR_PORT": "8765",
        "PID_TEST_FAILURE": "1" if failure else "0",
    })
    if override:
        environment["MURMUR_PID_FILE"] = str(tmp_path / "launcher" / "server.pid")
    main_path = Path(__file__).resolve().parents[1] / "src" / "main.py"
    if launch == "script":
        command = [sys.executable, str(main_path)]
    else:
        cli = shutil.which("murmur")
        assert cli is not None, "Run tests in the synced server environment"
        command = [cli]
    result = subprocess.run(command, cwd=tmp_path, env=environment,
                            capture_output=True, text=True, timeout=30)
    assert (result.returncode != 0) == failure, result.stderr
    if failure:
        assert "synthetic serving failure" in result.stderr
    assert list(tmp_path.rglob("server.pid")) == []


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
    assert context.audio_buffer.sample_count == 0
    assert context.audio_buffer._file is None


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
    assert context.audio_buffer.sample_count == 0
    assert context.audio_buffer._file is None


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
    assert context.audio_buffer.sample_count == 0
    assert context.audio_buffer._file is None
