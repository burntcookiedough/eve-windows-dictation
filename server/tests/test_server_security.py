"""Security-boundary and unauthenticated session abuse regressions."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError

import app as app_module
import config as config_module
import websocket.handler as handler_module
from config import Settings
from protocol.frames import StartFrame
from request_boundary import LocalRequestBoundary, is_loopback_host
from session.manager import SessionManager
from session.state import SessionState
from transcription.processor import TranscriptionResult
from websocket.handler import _partial_emission_loop


class _ProbeApp:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, scope, receive, send) -> None:
        self.calls.append(scope["type"])
        if scope["type"] == "http":
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [],
                }
            )
            await send({"type": "http.response.body", "body": b"ok"})
        else:
            await send({"type": "websocket.accept"})


def _scope(
    scope_type: str,
    headers: list[tuple[str, str]],
    client: tuple[str, int] | None = ("127.0.0.1", 54321),
) -> dict[str, Any]:
    return {
        "type": scope_type,
        "headers": [(name.encode("ascii"), value.encode("ascii")) for name, value in headers],
        "client": client,
    }


def _invoke(app, scope: dict[str, Any]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        if scope["type"] == "websocket":
            return {"type": "websocket.connect"}
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    async def run() -> None:
        await app(scope, receive, send)

    asyncio.run(run())
    return messages


@pytest.mark.parametrize(
    ("scope_type", "headers", "rejection_type"),
    [
        (
            "http",
            [("host", "localhost:51717"), ("origin", "https://evil.example")],
            "http.response.start",
        ),
        ("http", [("host", "evil.example")], "http.response.start"),
        (
            "websocket",
            [("host", "localhost:51717"), ("origin", "null")],
            "websocket.close",
        ),
        ("websocket", [("host", "rebind.evil.example")], "websocket.close"),
    ],
)
def test_browser_origin_and_rebinding_are_rejected_before_endpoint(
    scope_type: str,
    headers: list[tuple[str, str]],
    rejection_type: str,
) -> None:
    endpoint = _ProbeApp()

    messages = _invoke(LocalRequestBoundary(endpoint), _scope(scope_type, headers))

    assert endpoint.calls == []
    rejection = next(message for message in messages if message["type"] == rejection_type)
    if scope_type == "http":
        assert rejection["status"] == 403
    else:
        assert rejection["code"] == 1008


def test_originless_loopback_http_and_websocket_clients_are_accepted() -> None:
    for scope_type, host, expected_message in (
        ("http", "localhost:51717", "http.response.start"),
        ("websocket", "127.0.0.1:51717", "websocket.accept"),
    ):
        endpoint = _ProbeApp()
        messages = _invoke(
            LocalRequestBoundary(endpoint),
            _scope(scope_type, [("host", host)]),
        )

        assert endpoint.calls == [scope_type]
        assert messages[0]["type"] == expected_message
        if scope_type == "http":
            assert messages[0]["status"] == 200


@pytest.mark.parametrize(
    ("scope_type", "rejection_type"),
    [("http", "http.response.start"), ("websocket", "websocket.close")],
)
def test_remote_peer_cannot_spoof_loopback_host(
    scope_type: str,
    rejection_type: str,
) -> None:
    endpoint = _ProbeApp()

    messages = _invoke(
        LocalRequestBoundary(endpoint),
        _scope(
            scope_type,
            [("host", "localhost:51717")],
            client=("203.0.113.9", 54321),
        ),
    )

    assert endpoint.calls == []
    rejection = next(message for message in messages if message["type"] == rejection_type)
    expected = 403 if scope_type == "http" else 1008
    assert rejection.get("status", rejection.get("code")) == expected


@pytest.mark.parametrize("peer", ["testclient", "not-an-ip"])
def test_unparseable_peer_names_are_not_trusted_as_loopback(peer: str) -> None:
    endpoint = _ProbeApp()

    messages = _invoke(
        LocalRequestBoundary(endpoint),
        _scope("http", [("host", "localhost:51717")], client=(peer, 54321)),
    )

    assert endpoint.calls == []
    assert messages[0]["status"] == 403


@pytest.mark.parametrize("client", [None, ("127.0.0.1", 54321)])
def test_in_process_scopes_without_network_peer_remain_usable(
    client: tuple[str, int] | None,
) -> None:
    endpoint = _ProbeApp()

    messages = _invoke(
        LocalRequestBoundary(endpoint),
        _scope("http", [("host", "localhost:51717")], client=client),
    )

    assert endpoint.calls == ["http"]
    assert messages[0]["status"] == 200


def test_loopback_host_parser_rejects_noncanonical_or_rebinding_hosts() -> None:
    assert all(
        is_loopback_host(host)
        for host in ("localhost", "localhost:51717", "127.0.0.1:51717", "[::1]:51717")
    )
    assert not any(
        is_loopback_host(host)
        for host in (
            "localhost.evil.example",
            "127.0.0.1.evil.example",
            "2130706433",
            "user@localhost",
            "localhost:65536",
            "localhost:0",
        )
    )


def test_server_app_installs_local_request_boundary() -> None:
    app = app_module.create_app()

    assert any(item.cls is LocalRequestBoundary for item in app.user_middleware)


def test_first_audio_grace_allows_slow_microphone_permission_prompt() -> None:
    assert handler_module.FIRST_AUDIO_TIMEOUT_SECONDS == 30.0


def test_server_partial_interval_setting_matches_supported_range() -> None:
    assert Settings.model_validate(
        {"partial_emission_interval": 0.1}
    ).partial_emission_interval == 0.1
    assert Settings.model_validate(
        {"partial_emission_interval": 2.0}
    ).partial_emission_interval == 2.0

    for value in (1e-300, 0.099, 2.001):
        with pytest.raises(ValidationError):
            Settings.model_validate({"partial_emission_interval": value})

    for value in (float("nan"), float("inf"), float("-inf"), True):
        with pytest.raises(ValidationError):
            Settings.model_validate({"partial_emission_interval": value})


def test_settings_api_and_start_frame_keep_strict_interval_bounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config_module, "_settings", Settings.model_validate({}))
    monkeypatch.setattr(config_module, "_load_environment_settings", lambda _source: {})
    monkeypatch.setattr(config_module, "_load_dotenv_settings", lambda _source: {})
    monkeypatch.setattr(config_module, "_load_settings_json", lambda: {})

    for value in (0.05, 3.0, float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValidationError):
            config_module.build_settings_candidate({"partial_emission_interval": value})
        with pytest.raises(ValidationError):
            StartFrame(silence_timeout=5.0, partial_emission_interval=value)


def _no_migration(values: dict[str, Any]) -> SimpleNamespace:
    return SimpleNamespace(values=values, migrated=False, diagnostic=None)


def test_persisted_intervals_are_clamped_without_discarding_other_settings(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(config_module, "get_settings_file_path", lambda: settings_path)
    monkeypatch.setattr(
        config_module.legacy_settings,
        "migrate_persisted_settings",
        _no_migration,
    )

    for interval, expected in ((0.05, 0.1), (3.0, 2.0)):
        settings_path.write_text(
            json.dumps({"partial_emission_interval": interval, "whisper_language": "de"}),
            encoding="utf-8",
        )
        settings = Settings.model_validate(config_module._load_settings_json())

        assert settings.partial_emission_interval == expected
        assert settings.whisper_language == "de"


@pytest.mark.parametrize(
    ("loader_name", "interval", "expected"),
    [
        ("_load_environment_settings", 0.05, 0.1),
        ("_load_environment_settings", 3.0, 2.0),
        ("_load_dotenv_settings", 0.05, 0.1),
        ("_load_dotenv_settings", 3.0, 2.0),
    ],
)
def test_environment_and_dotenv_intervals_are_clamped_without_losing_values(
    loader_name: str,
    interval: float,
    expected: float,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config_module.legacy_settings, "migrate_raw_settings", _no_migration)
    monkeypatch.setattr(config_module.legacy_settings, "legacy_environment_values", lambda: {})
    loader = getattr(config_module, loader_name)

    def source() -> dict[str, Any]:
        return {"partial_emission_interval": interval, "whisper_language": "fr"}

    settings = Settings.model_validate(loader(source))

    assert settings.partial_emission_interval == expected
    assert settings.whisper_language == "fr"


@pytest.mark.parametrize(
    "interval",
    [0.0, -0.1, float("nan"), float("inf"), float("-inf"), "invalid", True],
)
def test_invalid_trusted_intervals_are_still_rejected(
    interval: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config_module.legacy_settings, "migrate_raw_settings", _no_migration)
    monkeypatch.setattr(config_module.legacy_settings, "legacy_environment_values", lambda: {})

    values = config_module._load_environment_settings(
        lambda: {"partial_emission_interval": interval, "whisper_language": "it"}
    )

    with pytest.raises(ValidationError):
        Settings.model_validate(values)


@pytest.mark.asyncio
async def test_partial_emission_loop_yields_when_interval_has_elapsed() -> None:
    from session.context import SessionContext

    context = SessionContext()
    context.state_machine.transition_to(SessionState.STARTED)

    class NoAudioProcessor:
        calls = 0

        async def transcribe_partial(self):
            self.calls += 1
            return None

    processor = NoAudioProcessor()
    task = asyncio.create_task(
        _partial_emission_loop(SimpleNamespace(), context, processor, 1e-300)
    )
    await asyncio.wait_for(asyncio.sleep(0), timeout=1.0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert processor.calls >= 1


class _IdleWebSocket:
    def __init__(self) -> None:
        self._sent_start = False
        self._closed = asyncio.Event()
        self.closed = False

    async def accept(self) -> None:
        return

    async def receive(self) -> dict[str, Any]:
        if not self._sent_start:
            self._sent_start = True
            return {
                "type": "websocket.receive",
                "text": json.dumps(
                    {
                        "frame": "control",
                        "type": "start",
                        "silence_timeout": 300.0,
                    }
                ),
            }
        await self._closed.wait()
        return {"type": "websocket.disconnect", "code": 1000}

    async def close(self) -> None:
        self.closed = True
        self._closed.set()


class _IdleSender:
    async def send_error(self, *args, **kwargs) -> None:
        return

    async def send_ready(self, *args, **kwargs) -> None:
        return

    async def send_partial(self, *args, **kwargs) -> None:
        return

    async def send_status(self, *args, **kwargs) -> None:
        return

    async def send_final(self, *args, **kwargs) -> None:
        return

    async def send_closing(self, *args, **kwargs) -> None:
        return


class _IdleProcessor:
    def __init__(self, context) -> None:
        self.closed = False

    async def transcribe_partial(self):
        return None

    async def transcribe_final(self, progress_callback=None) -> TranscriptionResult:
        return TranscriptionResult(
            text="",
            confidence=0.0,
            is_empty=True,
            transcription_time=0.0,
            audio_duration=0.0,
            last_speech_end=None,
        )

    def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_started_session_without_audio_closes_and_releases_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = SessionManager(max_sessions=1)
    websocket = _IdleWebSocket()
    processor = _IdleProcessor(None)
    runtime = SimpleNamespace(status=lambda: SimpleNamespace(kind="ready"))
    settings = SimpleNamespace(start_timeout=10.0, partial_emission_interval=0.25)

    monkeypatch.setattr(handler_module, "get_settings", lambda: settings)
    monkeypatch.setattr(handler_module, "FIRST_AUDIO_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(handler_module, "get_session_manager", lambda: manager)
    monkeypatch.setattr(handler_module, "get_model_runtime", lambda: runtime)
    monkeypatch.setattr(handler_module, "runtime_accepts_sessions", lambda status: True)
    monkeypatch.setattr(handler_module, "TranscriptionProcessor", lambda context: processor)
    monkeypatch.setattr(handler_module, "FrameSender", lambda *args: _IdleSender())

    await handler_module.websocket_handler(websocket)

    assert websocket.closed is True
    assert processor.closed is True
    assert manager.active_count == 0
    replacement = manager.create_session()
    manager.remove_session(replacement.session_id)


def test_server_long_dictation_settings_match_supported_range() -> None:
    assert config_module._normalize_trusted_partial_interval(
        {"long_dictation_threshold_s": 0.5}
    )["long_dictation_threshold_s"] == 0.5
    assert Settings.model_validate(
        {"long_dictation_threshold_s": 5.0}
    ).long_dictation_threshold_s == 5.0
    assert Settings.model_validate(
        {"long_dictation_threshold_s": 120.0}
    ).long_dictation_threshold_s == 120.0
    assert Settings.model_validate(
        {"long_dictation_chunk_s": 5.0}
    ).long_dictation_chunk_s == 5.0
    assert Settings.model_validate(
        {"long_dictation_chunk_s": 60.0}
    ).long_dictation_chunk_s == 60.0

    for value in (0.0, -1.0, 120.1, float("nan"), float("inf"), float("-inf"), True):
        with pytest.raises(ValidationError):
            Settings.model_validate({"long_dictation_threshold_s": value})

    for value in (1.0, 0.5, 60.1, float("nan"), float("inf"), float("-inf"), True):
        with pytest.raises(ValidationError):
            Settings.model_validate({"long_dictation_chunk_s": value})


def test_persisted_long_dictation_settings_are_clamped_without_discarding_other_settings(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(config_module, "get_settings_file_path", lambda: settings_path)
    monkeypatch.setattr(
        config_module.legacy_settings,
        "migrate_persisted_settings",
        _no_migration,
    )

    settings_path.write_text(
        json.dumps({
            "long_dictation_threshold_s": 8000.0,
            "long_dictation_chunk_s": 8000.0,
            "whisper_language": "ja",
        }),
        encoding="utf-8",
    )
    settings = Settings.model_validate(config_module._load_settings_json())

    assert settings.long_dictation_threshold_s == 120.0
    assert settings.long_dictation_chunk_s == 60.0
    assert settings.whisper_language == "ja"
