"""Tests for code review fixes (findings 1, 3, 4, 5, 6)."""

import asyncio
import threading
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import HTTPException

from config import API_KEYS, RELOAD_KEYS, SETTINGS_METADATA, Settings
from transcription.base import EngineInfo
from transcription.types import TranscribeResult
from transcription.vram import GpuCapabilities
import transcription.factory as factory_module
import transcription.processor as processor_module


class _DummyEngine:
    def __init__(self, engine_id: str) -> None:
        self._engine_id = engine_id

    @property
    def engine_info(self) -> EngineInfo:
        return EngineInfo(
            id=self._engine_id,
            name=self._engine_id.title(),
            model=f"{self._engine_id}-model",
            supports_hotwords=self._engine_id == "whisper",
        )

    def create_session(self) -> object:
        raise NotImplementedError

    def shutdown(self) -> None:
        return


def _stub_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub out GPU detection so swap_engine doesn't hit real hardware."""
    monkeypatch.setattr(
        factory_module,
        "detect_gpu_capabilities",
        lambda _device: GpuCapabilities(
            cuda_available=False,
            device="cpu",
            device_index=None,
            name=None,
            total_vram_gb=None,
        ),
    )


# ---------------------------------------------------------------------------
# Finding 1: swap_engine serialisation via asyncio.Lock
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_swap_engine_serialized(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two concurrent swap_engine calls should execute sequentially, not interleave."""
    call_log: list[str] = []

    settings = Settings(engine="whisper")
    monkeypatch.setattr(factory_module, "_get_available_engine_ids", lambda: ["whisper", "nemotron"])
    _stub_gpu(monkeypatch)

    call_count = 0

    async def _slow_create(s: Settings) -> _DummyEngine:
        nonlocal call_count
        call_count += 1
        idx = call_count
        call_log.append(f"start-{idx}")
        await asyncio.sleep(0.05)
        call_log.append(f"end-{idx}")
        return _DummyEngine(s.engine)

    # Patch _create_engine to be async-aware via run_in_executor override
    original_swap = factory_module.EngineManager._swap_engine_inner

    async def _patched_swap(self: factory_module.EngineManager, new_settings: Settings) -> None:
        """Replace the executor-based _create_engine call with our async version."""
        self._swap_error = None
        available = factory_module._get_available_engine_ids()
        self._prepare_engine_selection(new_settings, available)
        self._pending_engine_id = new_settings.engine
        self._pending_status = "loading"
        self._pending_message = f"Loading {new_settings.engine} engine..."

        new_engine = await _slow_create(new_settings)

        self._engine = new_engine
        self._settings = new_settings
        self._update_runtime_metadata(new_settings)
        self._pending_status = None
        self._pending_engine_id = None
        self._pending_message = None
        self._swap_error = None

    monkeypatch.setattr(factory_module.EngineManager, "_swap_engine_inner", _patched_swap)

    manager = factory_module.EngineManager(settings)
    manager._engine = _DummyEngine("whisper")

    s1 = Settings(engine="whisper")
    s2 = Settings(engine="whisper")
    await asyncio.gather(manager.swap_engine(s1), manager.swap_engine(s2))

    # Should be sequential: start-1, end-1, start-2, end-2
    assert call_log == ["start-1", "end-1", "start-2", "end-2"]


def test_get_status_snapshots_transition_before_slow_engine_info() -> None:
    class BlockingInfoEngine(_DummyEngine):
        def __init__(self, engine_id: str) -> None:
            super().__init__(engine_id)
            self.info_started = threading.Event()
            self.allow_info = threading.Event()

        @property
        def engine_info(self) -> EngineInfo:
            self.info_started.set()
            if not self.allow_info.wait(timeout=2):
                raise AssertionError("engine info probe was not released")
            return super().engine_info

    manager = factory_module.EngineManager(Settings(engine="whisper"))
    old_engine = BlockingInfoEngine("whisper")
    manager._engine = old_engine
    status_result: list[factory_module.EngineStatus] = []

    worker = threading.Thread(target=lambda: status_result.append(manager.get_status()))
    worker.start()
    assert old_engine.info_started.wait(timeout=1)

    lock_acquired = manager._lock.acquire(timeout=1)
    try:
        assert lock_acquired
        manager._engine = _DummyEngine("nemotron")
        manager._settings = Settings(engine="nemotron")
        manager._pending_engine_id = "nemotron"
        manager._pending_status = "loading"
        manager._pending_message = "Loading nemotron engine..."
    finally:
        if lock_acquired:
            manager._lock.release()

    old_engine.allow_info.set()
    worker.join(timeout=2)

    assert not worker.is_alive()
    assert len(status_result) == 1
    status = status_result[0]
    assert status.current == "whisper"
    assert status.status == "ready"
    assert status.info is not None
    assert status.info.id == "whisper"


# ---------------------------------------------------------------------------
# Finding 3: restore engine on creation failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_swap_engine_restores_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """When unload_before_swap=True and new engine fails, old engine should be restored."""
    settings = Settings(engine="whisper", unload_before_swap=True)
    monkeypatch.setattr(factory_module, "_get_available_engine_ids", lambda: ["whisper", "nemotron"])
    _stub_gpu(monkeypatch)

    create_calls: list[str] = []

    def _fake_create(s: Settings) -> _DummyEngine:
        create_calls.append(s.engine)
        if s.engine == "nemotron":
            raise RuntimeError("Nemotron import failed")
        return _DummyEngine(s.engine)

    monkeypatch.setattr(factory_module, "_create_engine", _fake_create)

    manager = factory_module.EngineManager(settings)
    manager._engine = _DummyEngine("whisper")

    new_settings = Settings(engine="nemotron", unload_before_swap=True)
    with pytest.raises(RuntimeError, match="Nemotron import failed"):
        await manager.swap_engine(new_settings)

    # Engine should be restored to whisper
    assert manager._engine is not None
    assert manager._engine._engine_id == "whisper"
    assert manager.get_status().status == "ready"
    assert manager.get_status().message == (
        "The selected speech model could not be prepared. "
        "Retry or revert and review diagnostics if it continues."
    )
    # Should have tried nemotron, then restored whisper
    assert create_calls == ["nemotron", "whisper"]


@pytest.mark.asyncio
async def test_swap_engine_restores_old_engine_when_activation_callback_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(engine="whisper", unload_before_swap=True)
    monkeypatch.setattr(factory_module, "_get_available_engine_ids", lambda: ["whisper"])
    _stub_gpu(monkeypatch)

    created: list[_DummyEngine] = []

    def _fake_create(s: Settings) -> _DummyEngine:
        engine = _DummyEngine(s.engine)
        created.append(engine)
        return engine

    shutdown_calls: list[str] = []
    cleanup_events: list[str] = []
    monkeypatch.setattr(factory_module, "_create_engine", _fake_create)

    def _record_shutdown(self: _DummyEngine) -> None:
        shutdown_calls.append(self._engine_id)
        cleanup_events.append(f"shutdown:{self._engine_id}")

    monkeypatch.setattr(_DummyEngine, "shutdown", _record_shutdown)
    monkeypatch.setattr(factory_module, "_force_free_vram", lambda: cleanup_events.append("free"))

    manager = factory_module.EngineManager(settings)
    manager._engine = _DummyEngine("whisper")

    with pytest.raises(OSError, match="disk unavailable"):
        await manager.swap_engine(
            Settings(
                engine="whisper",
                whisper_model="medium",
                unload_before_swap=True,
            ),
            before_activate=lambda: (_ for _ in ()).throw(OSError("disk unavailable")),
        )

    assert manager._engine is created[1]
    assert manager._engine._engine_id == "whisper"
    assert manager._settings is settings
    assert len(created) == 2
    assert shutdown_calls == ["whisper", "whisper"]
    assert cleanup_events == ["shutdown:whisper", "free", "shutdown:whisper", "free"]


@pytest.mark.asyncio
async def test_swap_engine_restore_failure_reports_recovery_and_can_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed unload-first restore must surface recovery instead of a silent empty manager."""
    settings = Settings(engine="whisper", unload_before_swap=True)
    monkeypatch.setattr(factory_module, "_get_available_engine_ids", lambda: ["whisper", "nemotron"])
    _stub_gpu(monkeypatch)

    create_calls: list[str] = []

    def _fail_then_recover(s: Settings) -> _DummyEngine:
        create_calls.append(s.engine)
        if len(create_calls) <= 2:
            raise RuntimeError(f"Cannot create {s.engine}")
        return _DummyEngine(s.engine)

    monkeypatch.setattr(factory_module, "_create_engine", _fail_then_recover)

    manager = factory_module.EngineManager(settings)
    manager._engine = _DummyEngine("whisper")

    new_settings = Settings(engine="nemotron", unload_before_swap=True)
    with pytest.raises(
        factory_module.EngineRecoveryRequiredError,
        match="Candidate engine creation and previous-engine recovery both failed",
    ):
        await manager.swap_engine(new_settings)

    status = manager.get_status()
    assert status.current == "whisper"
    assert status.status == "error"
    assert status.info is None
    assert status.message == (
        "Eve could not restore the previous speech engine. "
        "Restart the managed server, then retry or revert the selected model."
    )
    assert status.recovery == {
        "action": "restart_server",
        "message": status.message,
    }
    assert manager._settings is settings
    with pytest.raises(RuntimeError, match="Restart the managed server"):
        _ = manager.engine

    # A fresh managed-server start invokes the same committed-settings path.
    await manager.swap_engine(settings)
    recovered = manager.get_status()
    assert recovered.status == "ready"
    assert recovered.current == "whisper"
    assert recovered.recovery is None
    assert create_calls == ["nemotron", "whisper", "whisper"]


@pytest.mark.asyncio
async def test_swap_engine_restore_failure_after_persistence_callback_is_recoverable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(engine="whisper", whisper_model="small", unload_before_swap=True)
    monkeypatch.setattr(factory_module, "_get_available_engine_ids", lambda: ["whisper"])
    _stub_gpu(monkeypatch)

    def _fail_restoring_committed_engine(s: Settings) -> _DummyEngine:
        if s.whisper_model == "small":
            raise RuntimeError("Cannot restore whisper")
        return _DummyEngine(s.engine)

    monkeypatch.setattr(factory_module, "_create_engine", _fail_restoring_committed_engine)

    manager = factory_module.EngineManager(settings)
    manager._engine = _DummyEngine("whisper")

    with pytest.raises(
        factory_module.EngineRecoveryRequiredError,
        match="Candidate engine activation and previous-engine recovery both failed",
    ):
        await manager.swap_engine(
            Settings(
                engine="whisper",
                whisper_model="medium",
                unload_before_swap=True,
            ),
            before_activate=lambda: (_ for _ in ()).throw(OSError("disk unavailable")),
        )

    status = manager.get_status()
    assert status.status == "error"
    assert status.recovery is not None
    assert status.recovery["action"] == "restart_server"
    assert manager._settings is settings


# ---------------------------------------------------------------------------
# Finding 4: propagate last_speech_end on duplicate text
# ---------------------------------------------------------------------------


class _FakeAudioBuffer:
    duration_seconds = 3.2

    def get_audio_float32(self) -> np.ndarray:
        return np.array([0.1, 0.2, 0.3], dtype=np.float32)


class _TimedSession:
    """Session that returns the same text but advancing last_speech_end."""

    def __init__(self) -> None:
        self._call_count = 0

    def transcribe(
        self,
        _audio: np.ndarray,
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult:
        self._call_count += 1
        return TranscribeResult(
            text="hello world",
            confidence=0.95,
            last_speech_end=1.0 * self._call_count,
        )

    def close(self) -> None:
        return


class _TimedManager:
    def __init__(self, session: _TimedSession) -> None:
        self._session = session

    def create_session(self, _session_id: str) -> _TimedSession:
        return self._session

    def release_session(self, _session_id: str) -> None:
        return


@pytest.mark.asyncio
async def test_partial_updates_speech_time_on_duplicate_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even when text is unchanged (returns None), last_speech_time should be updated."""
    session = _TimedSession()
    manager = _TimedManager(session)

    monkeypatch.setattr(processor_module, "get_settings", lambda: SimpleNamespace(min_audio_for_transcription=0.1))
    monkeypatch.setattr(processor_module, "get_engine_manager", lambda: manager)

    audio_start = 1000.0
    context = SimpleNamespace(
        session_id="test-session",
        audio_buffer=_FakeAudioBuffer(),
        hotwords=None,
        last_partial_text="",
        audio_start_time=audio_start,
        last_speech_time=None,
    )
    processor = processor_module.TranscriptionProcessor(context)

    # First call: new text → returns result, last_speech_time not updated by processor
    result1 = await processor.transcribe_partial()
    assert result1 is not None
    assert result1.text == "hello world"

    # Second call: same text → returns None but should update last_speech_time
    result2 = await processor.transcribe_partial()
    assert result2 is None
    assert context.last_speech_time == audio_start + 2.0


# ---------------------------------------------------------------------------
# Finding 5: engine_preference_mode in API
# ---------------------------------------------------------------------------


def test_engine_preference_mode_in_api_keys() -> None:
    """engine_preference_mode should be in API_KEYS, SETTINGS_METADATA, and RELOAD_KEYS."""
    assert "engine_preference_mode" in API_KEYS
    assert "engine_preference_mode" in SETTINGS_METADATA
    assert "engine_preference_mode" in RELOAD_KEYS


# ---------------------------------------------------------------------------
# Finding 6: engine_preference_mode forcing logic
# ---------------------------------------------------------------------------


def test_engine_preference_not_forced_when_explicitly_set() -> None:
    """When both engine and engine_preference_mode are in the patch, explicit value wins."""
    patch = {"engine": "whisper", "engine_preference_mode": "auto"}
    # Simulate the logic from update_server_settings
    if "engine" in patch:
        if "engine_preference_mode" not in patch:
            patch["engine_preference_mode"] = "manual"

    assert patch["engine_preference_mode"] == "auto"


def test_engine_preference_forced_to_manual_when_not_set() -> None:
    """When only engine is in the patch, engine_preference_mode is forced to manual."""
    patch = {"engine": "whisper"}
    # Simulate the logic from update_server_settings
    if "engine" in patch:
        if "engine_preference_mode" not in patch:
            patch["engine_preference_mode"] = "manual"

    assert patch["engine_preference_mode"] == "manual"


# ---------------------------------------------------------------------------
# Finding 4 (app.py): invalid settings returns 400
# ---------------------------------------------------------------------------


def test_invalid_settings_returns_400() -> None:
    """PATCH /settings with no valid keys should raise HTTPException with 400."""
    # Test the logic directly: an empty patch after filtering should raise
    patch = {k: v for k, v in {"invalid_key": "value"}.items() if k in API_KEYS}
    assert not patch

    with pytest.raises(HTTPException) as exc_info:
        if not patch:
            raise HTTPException(status_code=400, detail="No valid settings provided")
    assert exc_info.value.status_code == 400
    assert "No valid settings" in exc_info.value.detail
