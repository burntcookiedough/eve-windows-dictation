"""Cancellation must not unload a model underneath actual executor work."""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import numpy as np
import pytest

from session.context import SessionContext
import transcription.processor as module
from transcription.types import TranscribeResult


@pytest.mark.parametrize("overlap", [False, True])
@pytest.mark.parametrize("traced", [False, True])
@pytest.mark.parametrize("partial", [False, True])
async def test_cancelled_inference_keeps_lease_until_worker_finishes(
    monkeypatch, overlap, traced, partial,
):
    entered, release, closed = threading.Event(), threading.Event(), threading.Event()
    close_observations = []

    class Session:
        def transcribe(self, audio, **kwargs):
            entered.set()
            assert release.wait(3), "test worker was not released"
            return TranscribeResult("completed words", 0.9, 0.1)

    def close():
        close_observations.append(release.is_set())
        closed.set()

    lease = SimpleNamespace(session=Session(), close=close)
    monkeypatch.setattr(module, "get_model_runtime", lambda: SimpleNamespace(open_session=lambda _: lease))
    monkeypatch.setattr(module, "get_settings", lambda: SimpleNamespace(
        allow_overlapping_inference=overlap, transcription_max_workers=2,
        min_audio_for_transcription=0.01,
    ))
    context = SessionContext()
    context.audio_buffer.append(0, np.zeros(1600, dtype=np.int16))
    processor = module.TranscriptionProcessor(context)
    task = asyncio.create_task(processor.transcribe_partial() if partial else processor._run_transcribe(
        np.zeros(1600, dtype=np.float32), loop=asyncio.get_running_loop(),
        perf_collector={} if traced else None,
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        processor.close()
        processor.close()
        assert not closed.is_set(), "model lease released during native inference"
        release.set()
        assert await asyncio.to_thread(closed.wait, 2)
        assert close_observations == [True]
        with pytest.raises(RuntimeError, match="closed"):
            await processor._run_transcribe(np.zeros(1), loop=asyncio.get_running_loop())
    finally:
        release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.to_thread(module.shutdown_executor)
        processor.close()
        context.audio_buffer.close()


@pytest.mark.parametrize("cancel_queued", [False, True])
async def test_close_with_queued_inference_releases_exactly_once(monkeypatch, cancel_queued):
    release, entered, closed = threading.Event(), threading.Event(), threading.Event()
    calls = []
    loop_thread = threading.get_ident()
    executor = ThreadPoolExecutor(max_workers=1)

    def occupy_worker():
        entered.set()
        assert release.wait(3)

    blocker = executor.submit(occupy_worker)
    assert await asyncio.to_thread(entered.wait, 2)

    class Session:
        def transcribe(self, audio, **kwargs):
            assert not closed.is_set(), "queued inference used a closed lease"
            calls.append("inference")
            return TranscribeResult("queued words", 0.9, 0.1)

    def close():
        if cancel_queued:
            assert threading.get_ident() != loop_thread
        calls.append("close")
        closed.set()

    async def get_executor(_):
        return executor

    monkeypatch.setattr(module, "get_executor", get_executor)
    monkeypatch.setattr(module, "get_settings", lambda: SimpleNamespace(allow_overlapping_inference=True))
    monkeypatch.setattr(module, "get_model_runtime", lambda: SimpleNamespace(
        open_session=lambda _: SimpleNamespace(session=Session(), close=close),
    ))
    processor = module.TranscriptionProcessor(SessionContext())
    task = asyncio.create_task(processor._run_transcribe(np.zeros(1), loop=asyncio.get_running_loop()))
    try:
        # The task reaches the executor await before this callback resumes.
        await asyncio.sleep(0)
        processor.close()
        assert not closed.is_set()
        if cancel_queued:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        release.set()
        await asyncio.wrap_future(blocker)
        if not cancel_queued:
            assert (await task).text == "queued words"
        assert await asyncio.to_thread(closed.wait, 2)
        processor.close()
        assert calls == (["close"] if cancel_queued else ["inference", "close"])
    finally:
        release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.to_thread(executor.shutdown, wait=True)
        processor.close()


async def test_submission_failure_does_not_strand_a_lease(monkeypatch):
    closed = threading.Event()
    calls = []

    def close():
        calls.append("close")
        closed.set()

    class Executor:
        def submit(self, work):
            processor.close()  # Exercise close racing with a reserved submission.
            raise RuntimeError("executor unavailable")

    async def get_executor(_):
        return Executor()

    monkeypatch.setattr(module, "get_executor", get_executor)
    monkeypatch.setattr(module, "get_settings", lambda: SimpleNamespace(allow_overlapping_inference=True))
    monkeypatch.setattr(module, "get_model_runtime", lambda: SimpleNamespace(
        open_session=lambda _: SimpleNamespace(session=object(), close=close),
    ))
    context = SessionContext()
    processor = module.TranscriptionProcessor(context)
    try:
        with pytest.raises(RuntimeError, match="executor unavailable"):
            await processor._run_transcribe(np.zeros(1), loop=asyncio.get_running_loop())
        assert await asyncio.to_thread(closed.wait, 2)
        processor.close()
        assert calls == ["close"]
    finally:
        processor.close()
        context.audio_buffer.close()
