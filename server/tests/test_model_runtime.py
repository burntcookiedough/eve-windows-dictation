"""Behavioral tests for the Faster-Whisper model runtime seam.

These tests deliberately use a fake adapter through the public ``ModelRuntime``
interface.  They exercise generation ownership and lifecycle behavior without
reaching into runtime implementation details.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import replace
from typing import Callable

import numpy as np
import pytest

from transcription.model_runtime import ModelRuntime
from transcription.contracts import (
    Failed,
    ModelId,
    ModelInfo,
    ModelSession,
    PreparedModel,
    PreparationProgress,
    Preparing,
    Ready,
    SessionId,
    TranscribeOptions,
    TranscribeResult,
    WhisperConfig,
)


def _config(model: str) -> WhisperConfig:
    return WhisperConfig(
        model=ModelId(model),
        device="cpu",
        compute_type="int8",
        language="en",
        beam_size=1,
        temperature=0.0,
        condition_on_previous_text=False,
        without_timestamps=True,
        vad_filter=True,
        vad_min_silence_duration_ms=500,
        vad_speech_pad_ms=200,
        vad_threshold=0.5,
    )


def _info(model: str) -> ModelInfo:
    return ModelInfo(
        model=ModelId(model),
        repo_id=f"example/{model}",
        model_path=None,
        size_gb=1.0,
        languages=("en",),
        device="cpu",
        compute_type="int8",
        cuda_active=False,
        load_time_s=0.01,
        supports_hotwords=True,
        gpu_name=None,
        gpu_vram_gb=None,
        estimated_max_duration_s=None,
    )


class _Session(ModelSession):
    def __init__(self, model: str) -> None:
        self.model = model
        self.closed = False

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        hotwords: str | None = None,
        options: TranscribeOptions | None = None,
    ) -> TranscribeResult:
        return TranscribeResult(text=self.model, confidence=1.0, last_speech_end=float(len(audio)))

    def finalize(self) -> TranscribeResult:
        return TranscribeResult(text=self.model, confidence=1.0, last_speech_end=None)

    def close(self) -> None:
        self.closed = True


class _Prepared(PreparedModel):
    def __init__(self, model: str) -> None:
        self._info = _info(model)
        self.model = model
        self.shutdown_calls = 0
        self.session = _Session(model)
        self.shutdown_started: threading.Event | None = None
        self.shutdown_release: threading.Event | None = None

    def open_session(self) -> ModelSession:
        return self.session

    @property
    def info(self) -> ModelInfo:
        return self._info

    def shutdown(self) -> None:
        self.shutdown_calls += 1
        if self.shutdown_started is not None:
            self.shutdown_started.set()
        if self.shutdown_release is not None:
            assert self.shutdown_release.wait(timeout=2)


class _Adapter:
    def __init__(self) -> None:
        self.prepared: list[_Prepared] = []
        self.fail_for: set[str] = set()
        self.started = threading.Event()
        self.release = threading.Event()
        self.block_model: str | None = None
        self.progress: list[PreparationProgress] = []
        self.progress_callbacks: list[Callable[[PreparationProgress], None]] = []

    def prepare(self, config: WhisperConfig, progress: Callable[[PreparationProgress], None]) -> PreparedModel:
        self.progress_callbacks.append(progress)
        self.progress.append(PreparationProgress(candidate=config.model, phase="started", percent=0.0))
        progress(self.progress[-1])
        if str(config.model) == self.block_model:
            self.started.set()
            assert self.release.wait(timeout=2)
        if str(config.model) in self.fail_for:
            raise RuntimeError("candidate preparation failed")
        prepared = _Prepared(str(config.model))
        self.prepared.append(prepared)
        progress(PreparationProgress(candidate=config.model, phase="ready", percent=100.0))
        return prepared


@pytest.mark.asyncio
async def test_initial_preparation_rejects_sessions_and_replacement_admits_current_generation() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))

    adapter.block_model = "one"
    start_task = asyncio.create_task(runtime.start())
    for _ in range(100):
        if adapter.started.is_set():
            break
        await asyncio.sleep(0.01)
    with pytest.raises(RuntimeError, match="not ready"):
        runtime.open_session(SessionId("before-ready"))
    adapter.release.set()
    await start_task
    assert isinstance(runtime.status(), Ready)

    lease = runtime.open_session(SessionId("active"))
    replacement = asyncio.create_task(
        runtime.prepare_and_activate(_config("two"), persist=lambda: None, publish=lambda: None)
    )
    while not isinstance(runtime.status(), Preparing):
        await asyncio.sleep(0)
    replacement_lease = runtime.open_session(SessionId("replacement"))
    await replacement

    assert isinstance(runtime.status(), Ready)
    assert runtime.status().model.model == ModelId("two")
    assert lease.session.transcribe(np.zeros(1, dtype=np.float32)).text == "one"
    replacement_lease.close()
    lease.close()
    assert adapter.prepared[0].shutdown_calls == 1


@pytest.mark.asyncio
async def test_concurrent_start_calls_share_one_initial_preparation() -> None:
    adapter = _Adapter()
    adapter.block_model = "one"
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))

    first = asyncio.create_task(runtime.start())
    assert await asyncio.to_thread(adapter.started.wait, 2)
    second = asyncio.create_task(runtime.start())
    await asyncio.sleep(0)
    adapter.release.set()
    await asyncio.gather(first, second)

    assert len(adapter.prepared) == 1
    assert isinstance(runtime.status(), Ready)


@pytest.mark.asyncio
async def test_failed_candidate_and_persistence_leave_current_model_usable() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))
    await runtime.start()

    lease = runtime.open_session(SessionId("active"))
    adapter.fail_for.add("bad")
    with pytest.raises(RuntimeError, match="candidate preparation failed"):
        await runtime.prepare_and_activate(_config("bad"), persist=lambda: None, publish=lambda: None)

    assert isinstance(runtime.status(), Failed)
    assert runtime.status().current is not None
    assert runtime.status().current.model == ModelId("one")
    assert lease.session.transcribe(np.zeros(1, dtype=np.float32)).text == "one"

    adapter.fail_for.clear()
    with pytest.raises(OSError, match="disk unavailable"):
        await runtime.prepare_and_activate(
            _config("two"),
            persist=lambda: (_ for _ in ()).throw(OSError("disk unavailable")),
            publish=lambda: None,
        )
    assert isinstance(runtime.status(), Failed)
    assert runtime.status().current is not None
    assert runtime.status().current.model == ModelId("one")
    assert adapter.prepared[-1].shutdown_calls == 1
    lease.close()


@pytest.mark.asyncio
async def test_stale_progress_from_same_model_generation_is_ignored() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))
    await runtime.start()

    adapter.block_model = "one"
    adapter.release.clear()
    replacement_task = asyncio.create_task(
        runtime.prepare_and_activate(
            replace(_config("one"), language="de"),
            persist=lambda: None,
            publish=lambda: None,
        )
    )
    for _ in range(100):
        if adapter.started.is_set():
            break
        await asyncio.sleep(0.01)
    assert adapter.started.is_set()
    before = runtime.status()
    assert isinstance(before, Preparing)
    assert before.progress is not None

    # The initial adapter callback names the same model but belongs to the
    # retired generation.  Candidate-only checks would incorrectly accept it.
    adapter.progress_callbacks[0](
        PreparationProgress(candidate=ModelId("one"), phase="stale", percent=99.0)
    )
    after = runtime.status()
    assert isinstance(after, Preparing)
    assert after.progress == before.progress

    adapter.release.set()
    await replacement_task


@pytest.mark.asyncio
async def test_replacing_without_leases_shuts_down_old_generation_once() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))
    await runtime.start()

    await runtime.prepare_and_activate(_config("two"), persist=lambda: None, publish=lambda: None)

    assert adapter.prepared[0].shutdown_calls == 1
    assert adapter.prepared[1].shutdown_calls == 0


@pytest.mark.asyncio
async def test_same_model_update_runs_persist_and_publish_without_reloading() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))
    await runtime.start()
    events: list[str] = []

    await runtime.prepare_and_activate(
        _config("one"),
        persist=lambda: events.append("persist"),
        publish=lambda: events.append("publish"),
    )

    assert events == ["persist", "publish"]
    assert len(adapter.prepared) == 1


@pytest.mark.asyncio
async def test_scheduled_replacement_reserves_before_background_task_runs() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))
    await runtime.start()
    adapter.block_model = "two"

    first = runtime.schedule_prepare_and_activate(
        _config("two"), persist=lambda: None, publish=lambda: None
    )
    with pytest.raises(RuntimeError, match="already in progress"):
        runtime.schedule_prepare_and_activate(
            _config("three"), persist=lambda: None, publish=lambda: None
        )
    adapter.release.set()
    await first

    assert runtime.status().model.model == ModelId("two")


@pytest.mark.asyncio
async def test_cancellation_after_activation_keeps_new_generation_usable() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))
    await runtime.start()
    old = adapter.prepared[0]
    old.shutdown_started = threading.Event()
    old.shutdown_release = threading.Event()

    replacement = asyncio.create_task(
        runtime.prepare_and_activate(_config("two"), persist=lambda: None, publish=lambda: None)
    )
    assert await asyncio.to_thread(old.shutdown_started.wait, 2)
    replacement.cancel()
    old.shutdown_release.set()
    with pytest.raises(asyncio.CancelledError):
        await replacement

    lease = runtime.open_session(SessionId("new"))
    assert lease.session.transcribe(np.zeros(1, dtype=np.float32)).text == "two"
    assert adapter.prepared[1].shutdown_calls == 0
    lease.close()


@pytest.mark.asyncio
async def test_shutdown_joins_lease_triggered_native_shutdown() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))
    await runtime.start()
    lease = runtime.open_session(SessionId("old"))
    await runtime.prepare_and_activate(_config("two"), persist=lambda: None, publish=lambda: None)
    old = adapter.prepared[0]
    old.shutdown_started = threading.Event()
    old.shutdown_release = threading.Event()

    close_task = asyncio.create_task(asyncio.to_thread(lease.close))
    assert await asyncio.to_thread(old.shutdown_started.wait, 2)
    shutdown_task = asyncio.create_task(runtime.shutdown())
    await asyncio.sleep(0)
    assert not shutdown_task.done()
    old.shutdown_release.set()
    await asyncio.gather(close_task, shutdown_task)

    assert old.shutdown_calls == 1


@pytest.mark.asyncio
async def test_cancelled_replacement_joins_native_prepare_and_discards_candidate() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))
    await runtime.start()
    adapter.block_model = "two"
    apply_task = asyncio.create_task(
        runtime.prepare_and_activate(
            _config("two"),
            persist=lambda: pytest.fail("must not persist"),
            publish=lambda: None,
        )
    )
    for _ in range(100):
        if adapter.started.is_set():
            break
        await asyncio.sleep(0.01)
    assert adapter.started.is_set()

    apply_task.cancel()
    await asyncio.sleep(0)
    assert not apply_task.done()
    adapter.release.set()
    with pytest.raises(asyncio.CancelledError):
        await apply_task

    assert adapter.prepared[-1].model == "two"
    assert adapter.prepared[-1].shutdown_calls == 1
    assert adapter.prepared[0].shutdown_calls == 0
    status = runtime.status()
    assert isinstance(status, Ready)
    assert status.model.model == ModelId("one")


@pytest.mark.asyncio
async def test_shutdown_waits_for_native_prepare_and_discards_candidate() -> None:
    adapter = _Adapter()
    runtime = ModelRuntime(adapter=adapter, initial=_config("one"))
    await runtime.start()
    adapter.block_model = "two"
    apply_task = asyncio.create_task(
        runtime.prepare_and_activate(_config("two"), persist=lambda: pytest.fail("must not persist"), publish=lambda: None)
    )
    for _ in range(100):
        if adapter.started.is_set():
            break
        await asyncio.sleep(0.01)
    assert adapter.started.is_set()

    shutdown_task = asyncio.create_task(runtime.shutdown())
    await asyncio.sleep(0)
    assert runtime.status().kind == "stopping"
    adapter.release.set()
    await asyncio.gather(apply_task, shutdown_task)

    assert runtime.status().kind == "stopping"
    assert adapter.prepared[-1].model == "two"
    assert adapter.prepared[-1].shutdown_calls == 1
    assert adapter.prepared[0].shutdown_calls == 1
