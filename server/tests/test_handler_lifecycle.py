"""Real WebSocket handler lifecycle tests with backing file deletion and lease management."""

import asyncio
import json
import os
import struct
import threading
from collections.abc import Callable
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest
from starlette.websockets import WebSocketDisconnect

import websocket.handler as handler_module
from audio.buffer import AudioBuffer
from config import Settings
from protocol.frames import ClosingReason
from session.context import SessionContext
from session.manager import SessionManager
from session.state import SessionState
from transcription.processor import TranscriptionResult, TranscribeResult


async def _wait_until(predicate: Callable[[], bool]) -> None:
    """Fail promptly if the handler never reaches the expected test state."""
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(poll(), timeout=2.0)


class TrackedAudioBuffer(AudioBuffer):
    """AudioBuffer subclass tracking actual filesystem backing paths upon rollover."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.observed_backing_path: str | None = None
        self.first_append_event = asyncio.Event()
        self.fail_on_append = False

    def append(self, sequence: int, samples: np.ndarray) -> None:
        if self.fail_on_append:
            raise OSError("Simulated ENOSPC storage failure")
        super().append(sequence, samples)
        if self.observed_backing_path is None and self._file is not None:
            name = getattr(self._file, "name", None)
            if not name and hasattr(self._file, "_file"):
                name = getattr(self._file._file, "name", None)
            if isinstance(name, str) and os.path.isabs(name):
                self.observed_backing_path = name
        try:
            loop = asyncio.get_running_loop()
            loop.call_soon_threadsafe(self.first_append_event.set)
        except RuntimeError:
            pass


class _LifecycleWebSocket:
    """Mock WebSocket simulating client interactions with queue-driven messages."""

    def __init__(self, messages: list[dict | BaseException] | None = None) -> None:
        self.accepted = False
        self.closed = False
        self.close_code: int | None = None
        self.sent_messages: list[str | bytes] = []
        self._inbox: asyncio.Queue[dict | BaseException] = asyncio.Queue()
        if messages:
            for msg in messages:
                self._inbox.put_nowait(msg)
        self._closed_event = asyncio.Event()

    def queue_message(self, msg: dict | BaseException) -> None:
        self._inbox.put_nowait(msg)

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000) -> None:
        self.closed = True
        self.close_code = code
        self._closed_event.set()
        self._inbox.put_nowait(WebSocketDisconnect(code=code))

    async def send_json(self, data: dict) -> None:
        self.sent_messages.append(json.dumps(data))

    async def send_text(self, data: str) -> None:
        self.sent_messages.append(data)

    async def send_bytes(self, data: bytes) -> None:
        self.sent_messages.append(data)

    async def receive(self) -> dict:
        item = await self._inbox.get()
        if isinstance(item, BaseException):
            raise item
        return item


class _LifecycleProcessor:
    def __init__(self, context: SessionContext) -> None:
        self.context = context
        self.closed = False
        self.transcribe_final_calls = 0
        self.transcribe_partial_calls = 0
        self.in_final_event = asyncio.Event()
        self.final_gate = asyncio.Event()
        self.raise_in_final = False

    async def transcribe_partial(self) -> TranscriptionResult | None:
        self.transcribe_partial_calls += 1
        return None

    async def transcribe_final(self, progress_callback=None) -> TranscriptionResult:
        self.transcribe_final_calls += 1
        self.in_final_event.set()
        if hasattr(self, "_wait_final_gate") and self._wait_final_gate:
            await self.final_gate.wait()
        if self.raise_in_final:
            raise RuntimeError("Simulated model engine failure during finalization")
        return TranscriptionResult(
            text="final transcript",
            confidence=0.9,
            is_empty=False,
            transcription_time=0.01,
            audio_duration=1.0,
            last_speech_end=1.0,
        )

    def close(self) -> None:
        self.closed = True


def _make_audio_frame(seq: int, samples: np.ndarray) -> dict:
    """Create binary audio frame for websocket receive."""
    raw_pcm = samples.astype("<i2").tobytes()
    # Header: sequence(u16), sample_count(u16), flags(u8=0) in big-endian
    header = struct.pack(">HHB", seq, len(samples), 0)
    return {"type": "websocket.receive", "bytes": header + raw_pcm}


def _make_control_frame(msg_type: str, **kwargs) -> dict:
    payload = {"frame": "control", "type": msg_type, **kwargs}
    return {"type": "websocket.receive", "text": json.dumps(payload)}


@pytest.fixture
def lifecycle_env(monkeypatch: pytest.MonkeyPatch):
    manager = SessionManager(max_sessions=5)
    settings = Settings(start_timeout=5.0, partial_emission_interval=0.1)
    runtime = SimpleNamespace(status=lambda: SimpleNamespace(kind="ready"))

    tracked_buffers: list[TrackedAudioBuffer] = []
    original_create_session = manager.create_session

    def tracked_create_session() -> SessionContext:
        ctx = original_create_session()
        # Swap fresh buffer with small resident cap (128 bytes) before frames arrive
        # and before processor is created, forcing disk rollover on first audio append
        ctx.audio_buffer.close()
        tracked_buf = TrackedAudioBuffer(_max_resident_bytes=128)
        ctx.audio_buffer = tracked_buf
        tracked_buffers.append(tracked_buf)
        return ctx

    manager.create_session = tracked_create_session

    monkeypatch.setattr(handler_module, "get_session_manager", lambda: manager)
    monkeypatch.setattr(handler_module, "get_settings", lambda: settings)
    monkeypatch.setattr(handler_module, "get_model_runtime", lambda: runtime)
    monkeypatch.setattr(handler_module, "runtime_accepts_sessions", lambda status: True)

    return SimpleNamespace(manager=manager, settings=settings, tracked_buffers=tracked_buffers)


@pytest.mark.asyncio
async def test_handler_client_disconnect_cleans_backing_storage_and_leases(
    lifecycle_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Client disconnect triggers outer teardown, deleting spool files and releasing leases."""
    created_processors: list[_LifecycleProcessor] = []

    def make_processor(ctx):
        proc = _LifecycleProcessor(ctx)
        created_processors.append(proc)
        return proc

    monkeypatch.setattr(handler_module, "TranscriptionProcessor", make_processor)

    # 500 samples of int16 = 1000 bytes > 128 bytes resident cap (forces disk rollover)
    samples = np.arange(500, dtype=np.int16)
    ws = _LifecycleWebSocket([
        _make_control_frame("start", silence_timeout=30.0),
        _make_audio_frame(0, samples),
        WebSocketDisconnect(code=1006),
    ])

    await handler_module.websocket_handler(ws)

    assert ws.closed is True
    assert len(created_processors) == 1
    processor = created_processors[0]
    assert processor.closed is True
    assert lifecycle_env.manager.active_count == 0

    # Backing storage rollover verified and unlinked from filesystem
    buf = lifecycle_env.tracked_buffers[0]
    assert buf.observed_backing_path is not None
    assert os.path.isabs(buf.observed_backing_path)
    assert not os.path.exists(buf.observed_backing_path)
    assert processor.context.state_machine.state == SessionState.CLOSED
    assert processor.context.audio_buffer.sample_count == 0
    assert processor.context.audio_buffer._file is None


@pytest.mark.asyncio
async def test_handler_capture_cancellation_cleans_storage_and_leases(
    lifecycle_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Handler task cancellation during capture executes outer finally teardown completely."""
    created_processors: list[_LifecycleProcessor] = []

    def make_processor(ctx):
        proc = _LifecycleProcessor(ctx)
        created_processors.append(proc)
        return proc

    monkeypatch.setattr(handler_module, "TranscriptionProcessor", make_processor)

    ws = _LifecycleWebSocket([
        _make_control_frame("start", silence_timeout=30.0),
        _make_audio_frame(0, np.ones(500, dtype=np.int16)),
    ])

    task = asyncio.create_task(handler_module.websocket_handler(ws))

    # Wait on explicit event for first audio frame append
    await _wait_until(lambda: bool(lifecycle_env.tracked_buffers))
    buf = lifecycle_env.tracked_buffers[0]
    await buf.first_append_event.wait()

    # Backing file exists on disk during capture
    assert buf.observed_backing_path is not None
    assert os.path.exists(buf.observed_backing_path)

    # Cancel handler task during capture
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert len(created_processors) == 1
    processor = created_processors[0]
    assert processor.closed is True
    assert lifecycle_env.manager.active_count == 0

    # Backing storage unlinked from filesystem upon capture cancellation
    assert not os.path.exists(buf.observed_backing_path)
    assert processor.context.state_machine.state == SessionState.CLOSED
    assert processor.context.audio_buffer.sample_count == 0
    assert processor.context.audio_buffer._file is None


@pytest.mark.asyncio
async def test_handler_finalization_cancellation_cleans_storage_and_leases(
    lifecycle_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Handler task cancellation during long finalization cleanly deletes storage and releases leases."""
    created_processors: list[_LifecycleProcessor] = []

    def make_processor(ctx):
        proc = _LifecycleProcessor(ctx)
        proc._wait_final_gate = True
        created_processors.append(proc)
        return proc

    monkeypatch.setattr(handler_module, "TranscriptionProcessor", make_processor)

    ws = _LifecycleWebSocket([
        _make_control_frame("start", silence_timeout=30.0),
        _make_audio_frame(0, np.ones(500, dtype=np.int16)),
        _make_control_frame("stop"),
    ])

    task = asyncio.create_task(handler_module.websocket_handler(ws))

    await _wait_until(lambda: bool(created_processors))
    processor = created_processors[0]
    buf = lifecycle_env.tracked_buffers[0]

    # Wait until finalization has begun and transcribe_final is in-flight
    await processor.in_final_event.wait()
    assert buf.observed_backing_path is not None
    assert os.path.exists(buf.observed_backing_path)

    # Cancel handler task while transcribe_final is awaiting
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert processor.closed is True
    assert lifecycle_env.manager.active_count == 0

    # Backing storage unlinked from filesystem upon finalization cancellation
    assert not os.path.exists(buf.observed_backing_path)
    assert processor.context.state_machine.state == SessionState.CLOSED
    assert processor.context.audio_buffer.sample_count == 0
    assert processor.context.audio_buffer._file is None


@pytest.mark.asyncio
async def test_handler_normal_stop_cleans_backing_storage_before_delayed_send_final(
    lifecycle_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Finalization clears backing storage BEFORE waiting on network socket transmission."""
    created_processors: list[_LifecycleProcessor] = []
    buffer_state_at_send_final: dict[str, object] = {}

    def make_processor(ctx):
        proc = _LifecycleProcessor(ctx)
        created_processors.append(proc)
        return proc

    monkeypatch.setattr(handler_module, "TranscriptionProcessor", make_processor)

    original_send_final = handler_module.FrameSender.send_final

    async def mock_send_final(self, *args, **kwargs):
        buf = lifecycle_env.tracked_buffers[0]
        buffer_state_at_send_final["observed_path"] = buf.observed_backing_path
        buffer_state_at_send_final["exists_on_disk"] = (
            os.path.exists(buf.observed_backing_path) if buf.observed_backing_path else None
        )
        buffer_state_at_send_final["sample_count"] = buf.sample_count
        buffer_state_at_send_final["file"] = buf._file
        buffer_state_at_send_final["closed"] = buf._closed
        # Delayed network transmission simulation
        await asyncio.sleep(0.02)
        await original_send_final(self, *args, **kwargs)

    monkeypatch.setattr(handler_module.FrameSender, "send_final", mock_send_final)

    ws = _LifecycleWebSocket([
        _make_control_frame("start", silence_timeout=30.0),
        _make_audio_frame(0, np.ones(500, dtype=np.int16)),
        _make_control_frame("stop"),
    ])

    await handler_module.websocket_handler(ws)

    assert len(created_processors) == 1
    processor = created_processors[0]
    assert processor.closed is True
    assert processor.transcribe_final_calls == 1

    # Invariant: backing disk file was already unlinked BEFORE send_final executed
    assert buffer_state_at_send_final["observed_path"] is not None
    assert buffer_state_at_send_final["exists_on_disk"] is False
    assert buffer_state_at_send_final["sample_count"] == 0
    assert buffer_state_at_send_final["file"] is None
    assert buffer_state_at_send_final["closed"] is True


@pytest.mark.asyncio
async def test_handler_storage_append_error_cleans_storage_and_leases(
    lifecycle_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Storage write failure during append unlinks temporary files and releases leases."""
    created_processors: list[_LifecycleProcessor] = []

    def make_processor(ctx):
        proc = _LifecycleProcessor(ctx)
        created_processors.append(proc)
        return proc

    monkeypatch.setattr(handler_module, "TranscriptionProcessor", make_processor)

    ws = _LifecycleWebSocket([
        _make_control_frame("start", silence_timeout=30.0),
        _make_audio_frame(0, np.ones(500, dtype=np.int16)),
    ])

    task = asyncio.create_task(handler_module.websocket_handler(ws))

    await _wait_until(lambda: bool(lifecycle_env.tracked_buffers))
    buf = lifecycle_env.tracked_buffers[0]
    await buf.first_append_event.wait()

    # Backing file exists on disk prior to error
    path = buf.observed_backing_path
    assert path is not None
    assert os.path.exists(path)

    # Trigger storage append error on next audio frame
    buf.fail_on_append = True
    ws.queue_message(_make_audio_frame(1, np.ones(500, dtype=np.int16)))

    await task

    assert len(created_processors) == 1
    processor = created_processors[0]
    assert processor.closed is True
    assert lifecycle_env.manager.active_count == 0

    # Backing storage unlinked from filesystem after storage append error
    assert not os.path.exists(path)
    assert processor.context.state_machine.state == SessionState.CLOSED
    assert processor.context.audio_buffer.sample_count == 0
    assert processor.context.audio_buffer._file is None


@pytest.mark.asyncio
@pytest.mark.parametrize("trace_enabled", [False, True])
async def test_handler_final_inference_error_cleans_storage_and_leases(
    lifecycle_env, trace_enabled, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Inference failure still delivers one final and cleans storage, with diagnostics on/off."""
    if trace_enabled:
        monkeypatch.setenv("MURMUR_PERF_TRACE", "1")
    else:
        monkeypatch.delenv("MURMUR_PERF_TRACE", raising=False)
    created_processors: list[_LifecycleProcessor] = []

    def make_processor(ctx):
        proc = _LifecycleProcessor(ctx)
        proc.raise_in_final = True
        created_processors.append(proc)
        return proc

    monkeypatch.setattr(handler_module, "TranscriptionProcessor", make_processor)

    ws = _LifecycleWebSocket([
        _make_control_frame("start", silence_timeout=30.0),
        _make_audio_frame(0, np.ones(500, dtype=np.int16)),
    ])

    task = asyncio.create_task(handler_module.websocket_handler(ws))

    await _wait_until(lambda: bool(lifecycle_env.tracked_buffers))
    buf = lifecycle_env.tracked_buffers[0]
    await buf.first_append_event.wait()

    path = buf.observed_backing_path
    assert path is not None
    assert os.path.exists(path)

    # Queue stop frame to trigger finalization with inference failure
    ws.queue_message(_make_control_frame("stop"))

    await task

    assert len(created_processors) == 1
    processor = created_processors[0]
    assert processor.closed is True
    assert lifecycle_env.manager.active_count == 0

    frames = [json.loads(message) for message in ws.sent_messages if isinstance(message, str)]
    finals = [frame for frame in frames if frame.get("type") == "final"]
    assert len(finals) == 1
    assert ("perf" in finals[0]) == trace_enabled

    # Backing file unlinked despite final inference error
    assert not os.path.exists(path)
    assert processor.context.state_machine.state == SessionState.CLOSED
    assert processor.context.audio_buffer.sample_count == 0
    assert processor.context.audio_buffer._file is None


@pytest.mark.asyncio
async def test_handler_silence_timeout_cleans_backing_storage_and_leases(
    lifecycle_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Silence monitor cycle triggers session teardown, deleting backing storage and closing leases."""
    created_processors: list[_LifecycleProcessor] = []

    def make_processor(ctx):
        proc = _LifecycleProcessor(ctx)
        created_processors.append(proc)
        return proc

    monkeypatch.setattr(handler_module, "TranscriptionProcessor", make_processor)

    ws = _LifecycleWebSocket([
        _make_control_frame("start", silence_timeout=0.2),
        _make_audio_frame(0, np.ones(500, dtype=np.int16)),
    ])

    task = asyncio.create_task(handler_module.websocket_handler(ws))

    await _wait_until(lambda: bool(lifecycle_env.tracked_buffers))
    buf = lifecycle_env.tracked_buffers[0]
    await buf.first_append_event.wait()

    path = buf.observed_backing_path
    assert path is not None
    assert os.path.exists(path)

    # Real 0.5s silence monitor cycle runs and detects audio gap >= 0.2s
    await task

    assert len(created_processors) == 1
    processor = created_processors[0]
    assert processor.closed is True
    assert processor.transcribe_final_calls == 1
    assert lifecycle_env.manager.active_count == 0

    # Backing storage unlinked upon silence timeout teardown
    assert not os.path.exists(path)
    assert processor.context.state_machine.state == SessionState.CLOSED
    assert processor.context.audio_buffer.sample_count == 0
    assert processor.context.audio_buffer._file is None
    # Verify closing frame reason was silence timeout
    closing_frames = [
        json.loads(msg) for msg in ws.sent_messages
        if isinstance(msg, str) and "closing" in msg
    ]
    assert any(cf.get("reason") == ClosingReason.SILENCE_TIMEOUT.value for cf in closing_frames)


@pytest.mark.asyncio
async def test_handler_background_exception_guarantees_lease_closure_and_cleanup(
    lifecycle_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Background task exceptions do not bypass processor.close() or storage cleanup (BUG-01 regression)."""
    created_processors: list[_LifecycleProcessor] = []

    def make_processor(ctx):
        proc = _LifecycleProcessor(ctx)
        created_processors.append(proc)
        return proc

    monkeypatch.setattr(handler_module, "TranscriptionProcessor", make_processor)

    # Inject an unhandled exception into partial emission loop
    async def failing_partial_loop(*args, **kwargs):
        await asyncio.sleep(0.01)
        raise RuntimeError("Simulated background engine crash")

    monkeypatch.setattr(handler_module, "_partial_emission_loop", failing_partial_loop)

    ws = _LifecycleWebSocket([
        _make_control_frame("start", silence_timeout=30.0),
        _make_audio_frame(0, np.ones(500, dtype=np.int16)),
    ])

    task = asyncio.create_task(handler_module.websocket_handler(ws))

    await _wait_until(lambda: bool(lifecycle_env.tracked_buffers))
    buf = lifecycle_env.tracked_buffers[0]
    await buf.first_append_event.wait()

    path = buf.observed_backing_path
    assert path is not None
    assert os.path.exists(path)

    ws.queue_message(WebSocketDisconnect(code=1000))
    await task

    assert len(created_processors) == 1
    processor = created_processors[0]
    # Processor lease is guaranteed closed and backing storage cleaned even though background task failed
    assert processor.closed is True
    assert lifecycle_env.manager.active_count == 0
    assert not os.path.exists(path)
    assert processor.context.audio_buffer._file is None


@pytest.mark.asyncio
async def test_partial_loop_skips_reading_in_finalizing_state() -> None:
    """_partial_emission_loop does not read buffer while in FINALIZING state (BUG-05 rejection)."""
    context = SessionContext()
    context.state_machine.transition_to(SessionState.STARTED)
    context.audio_buffer.append(0, np.ones(160, dtype=np.int16))

    processor = _LifecycleProcessor(context)
    sender = MagicMock()

    # Move state to FINALIZING
    context.state_machine.transition_to(SessionState.FINALIZING)
    assert not context.state_machine.is_accepting_audio()

    # Run partial loop briefly
    loop_task = asyncio.create_task(
        handler_module._partial_emission_loop(sender, context, processor, min_interval=0.01)
    )
    await asyncio.sleep(0.03)

    # Transition to CLOSED to end loop
    context.state_machine.transition_to(SessionState.CLOSED)
    await loop_task

    # Partial transcription was NEVER invoked while in FINALIZING
    assert processor.transcribe_partial_calls == 0
    context.audio_buffer.close()


@pytest.mark.asyncio
async def test_inflight_partial_synchronous_tail_snapshot_safe_across_buffer_close() -> None:
    """Synchronous tail snapshot read extracts detached numpy array; closing buffer immediately does not invalidate memory copy."""
    context = SessionContext()
    context.state_machine.transition_to(SessionState.STARTED)
    context.audio_buffer.append(0, np.ones(16000, dtype=np.int16))

    # Synchronous tail read creates an independent in-memory numpy array
    tail = context.audio_buffer.get_audio_tail_float32(16000)
    assert len(tail) == 16000

    # Buffer closes immediately while model would be running
    context.audio_buffer.close()
    assert context.audio_buffer._file is None

    # Model inference uses the existing independent copy without error
    model_output = np.mean(tail)
    assert model_output == pytest.approx(1.0 / 32768.0, rel=1e-4)


@pytest.mark.asyncio
async def test_inflight_partial_processor_await_probe_with_concurrent_buffer_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """TranscriptionProcessor.transcribe_partial maintains memory stability when buffer closes while awaiting model thread."""
    import transcription.processor as processor_module
    from transcription.processor import TranscriptionProcessor

    inference_started = threading.Event()
    buffer_closed_event = threading.Event()

    def mock_transcribe(audio, hotwords=None, options=None):
        inference_started.set()
        buffer_closed_event.wait(timeout=2.0)
        return TranscribeResult(text="probe transcript", confidence=0.9, last_speech_end=1.0)

    mock_session = MagicMock()
    mock_session.transcribe = mock_transcribe
    mock_lease = SimpleNamespace(session=mock_session, close=MagicMock())
    mock_runtime = SimpleNamespace(
        status=lambda: SimpleNamespace(kind="ready"),
        open_session=lambda sid: mock_lease,
    )
    monkeypatch.setattr(processor_module, "get_model_runtime", lambda: mock_runtime)

    context = SessionContext()
    context.state_machine.transition_to(SessionState.STARTED)
    context.audio_buffer.append(0, np.ones(16000, dtype=np.int16))

    processor = TranscriptionProcessor(context)
    task = asyncio.create_task(processor.transcribe_partial())

    # Wait until model thread begins executing
    await _wait_until(inference_started.is_set)

    # Concurrently close the audio buffer while inference is in flight
    context.audio_buffer.close()
    assert context.audio_buffer._file is None
    buffer_closed_event.set()

    result = await task
    assert result is not None
    assert result.text == "probe transcript"
    assert result.confidence == 0.9

    processor.close()
    assert mock_lease.close.called


def test_session_manager_remove_session_defensively_closes_audio_buffer() -> None:
    """SessionManager.remove_session defensively ensures buffer is closed and unlinked."""
    manager = SessionManager(max_sessions=2)
    context = manager.create_session()
    # Replace with tracked buffer with small resident cap
    context.audio_buffer.close()
    tracked_buf = TrackedAudioBuffer(_max_resident_bytes=128)
    context.audio_buffer = tracked_buf

    context.audio_buffer.append(0, np.ones(500, dtype=np.int16))
    path = tracked_buf.observed_backing_path
    assert path is not None
    assert os.path.exists(path)

    manager.remove_session(context.session_id)
    assert manager.active_count == 0
    assert context.audio_buffer.sample_count == 0
    assert context.audio_buffer._file is None
    assert context.audio_buffer._closed is True
    assert not os.path.exists(path)
