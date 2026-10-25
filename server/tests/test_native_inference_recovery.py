"""Exercise actual lazy adapter and terminal handler paths without model loads."""

from types import SimpleNamespace

import numpy as np
import pytest

from protocol.frames import ClosingReason
from session.context import SessionContext
from session.state import SessionState
from transcription.engines.whisper import WhisperSession, WhisperTranscribeOptions
from transcription.errors import IncompleteTranscriptionError, VramExhaustedError
from transcription.types import TranscribeOptions
import transcription.processor as processor_module
from websocket.handler import _finalize_session
from websocket.sender import FrameSender


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("message", [
    "CUDA failed with error out of memory", "CUDA out of memory. Tried to allocate 256 MiB",
])
def test_native_oom_preserves_current_call_segments(lazy, message):
    class Model:
        def transcribe(self, audio, **kwargs):
            if not lazy:
                raise RuntimeError(message)

            def segments():
                yield SimpleNamespace(text=" completed words", avg_logprob=-0.2, start=0.0, end=0.5)
                raise RuntimeError(message)

            return segments(), None

    latencies = []
    session = WhisperSession(Model(), WhisperTranscribeOptions(
        "en", 1, 0.0, False, False, False, {},
    ), latencies.append)
    with pytest.raises(VramExhaustedError) as failure:
        session.transcribe(np.zeros(16000, dtype=np.float32))
    expected = "completed words" if lazy else ""
    assert failure.value.last_result.text == expected
    assert session.finalize().text == expected
    assert isinstance(failure.value.__cause__, RuntimeError)
    assert len(latencies) == 1


@pytest.mark.parametrize("message", ["cuDNN execution failed", "CPU allocator out of memory"])
def test_unrelated_native_failure_is_not_cuda_oom(message):
    class Model:
        def transcribe(self, audio, **kwargs):
            raise RuntimeError(message)

    session = WhisperSession(Model(), WhisperTranscribeOptions(
        "en", 1, 0.0, False, False, False, {},
    ), lambda _: None)
    with pytest.raises(RuntimeError) as failure:
        session.transcribe(np.zeros(1, dtype=np.float32))
    assert not isinstance(failure.value, VramExhaustedError)
    assert message in str(failure.value) or message in str(failure.value.__cause__)


async def test_actual_finalization_failure_is_not_success_and_retains_partial():
    context = SessionContext()
    context.state_machine.transition_to(SessionState.STARTED)
    context.state_machine.transition_to(SessionState.STREAMING)
    context.last_partial_text = "available incomplete words"
    context.audio_buffer.append(0, np.zeros(1600, dtype=np.int16))

    class Processor:
        async def transcribe_final(self, **kwargs):
            raise RuntimeError("synthetic inference failure")

    class Socket:
        def __init__(self):
            self.frames = []

        async def send_json(self, frame):
            self.frames.append(frame)

    socket = Socket()
    await _finalize_session(FrameSender(socket, context.session_id), context, Processor(), ClosingReason.STOP_RECEIVED)
    assert [f["type"] for f in socket.frames] == ["partial", "error", "closing"]
    assert socket.frames[0]["text"] == "available incomplete words"
    assert "incomplete" in socket.frames[1]["message"].lower()
    assert context.state_machine.state == SessionState.CLOSED
    assert context.audio_buffer.sample_count == 0


@pytest.mark.parametrize("oom", [False, True])
@pytest.mark.parametrize("through_handler", [False, True])
async def test_lazy_failure_after_completed_chunks_retains_work(monkeypatch, oom, through_handler):
    class Model:
        calls = 0

        def transcribe(self, audio, **kwargs):
            self.calls += 1
            call = self.calls

            def segments():
                yield SimpleNamespace(text=f"chunk {call}", start=1.0, end=2.0, avg_logprob=-0.2)
                if call == 3:
                    raise RuntimeError("CUDA out of memory" if oom else "native execution failed")

            return segments(), None

    model = Model()
    session = WhisperSession(model, WhisperTranscribeOptions("en", 1, 0.0, False, False, False, {}), lambda _: None)
    monkeypatch.setattr(processor_module, "get_settings", lambda: SimpleNamespace(
        long_dictation_threshold_s=1.0, long_dictation_chunk_s=20.0,
    ))
    monkeypatch.setattr(processor_module, "get_model_runtime", lambda: SimpleNamespace(
        open_session=lambda _: SimpleNamespace(session=session, close=session.close),
    ))
    context = SessionContext()
    context.state_machine.transition_to(SessionState.STARTED)
    context.audio_buffer.append(0, np.zeros(70 * 16000, dtype=np.int16))
    context.last_partial_text = "stale early partial"
    processor = processor_module.TranscriptionProcessor(context)
    try:
        if through_handler:
            class Socket:
                frames = []

                async def send_json(self, frame):
                    self.frames.append(frame)

            socket = Socket()
            await _finalize_session(FrameSender(socket, context.session_id), context, processor, ClosingReason.STOP_RECEIVED)
            terminal = [f for f in socket.frames if f["type"] != "status"]
            assert [f["type"] for f in terminal] == ["partial", "error", "closing"]
            assert terminal[0]["text"] == "chunk 1 chunk 2 chunk 3"
        else:
            expected_error = VramExhaustedError if oom else IncompleteTranscriptionError
            with pytest.raises(expected_error) as failure:
                await processor.transcribe_final()
            assert isinstance(failure.value, VramExhaustedError) == oom
            assert failure.value.last_result.text == "chunk 1 chunk 2 chunk 3"
            assert isinstance(failure.value.__cause__, RuntimeError)
        assert model.calls == 3
    finally:
        processor.close()
        context.audio_buffer.close()


def test_adapter_current_call_metadata_and_failure_never_reuses_stale_result():
    class Model:
        calls = 0

        def transcribe(self, audio, **kwargs):
            self.calls += 1
            if self.calls == 2:
                raise RuntimeError("CUDA out of memory")
            return iter([SimpleNamespace(text="old words", start=0.2, end=0.7, avg_logprob=-0.2)]), None

    session = WhisperSession(Model(), WhisperTranscribeOptions("en", 1, 0.0, False, False, False, {}), lambda _: None)
    result = session.transcribe(np.zeros(16000), options=TranscribeOptions(mode="long_chunk"))
    assert [(s.text, s.start, s.end) for s in result.segments] == [("old words", 0.2, 0.7)]
    with pytest.raises(VramExhaustedError) as failure:
        session.transcribe(np.zeros(16000))
    assert failure.value.last_result.text == ""
    assert session.finalize().text == ""
