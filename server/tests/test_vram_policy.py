"""Tests for VRAM-aware engine policy and OOM fallback behavior."""

from types import SimpleNamespace

import numpy as np
import pytest

from config import Settings
from transcription.base import EngineInfo
from transcription.errors import VramExhaustedError
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


def test_factory_auto_falls_back_to_whisper_on_low_vram(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(engine="nemotron", engine_preference_mode="auto")
    created_engine_ids: list[str] = []

    monkeypatch.setattr(factory_module, "_get_available_engine_ids", lambda: ["nemotron", "whisper"])
    monkeypatch.setattr(
        factory_module,
        "detect_gpu_capabilities",
        lambda _device: GpuCapabilities(
            cuda_available=True,
            device="cuda",
            device_index=0,
            name="Test GPU",
            total_vram_gb=6.0,
        ),
    )

    def _fake_create_engine(current_settings: Settings) -> _DummyEngine:
        created_engine_ids.append(current_settings.engine)
        return _DummyEngine(current_settings.engine)

    monkeypatch.setattr(factory_module, "_create_engine", _fake_create_engine)

    manager = factory_module.EngineManager(settings)
    manager.load_initial_engine()

    assert settings.engine == "whisper"
    assert created_engine_ids == ["whisper"]
    assert manager.engine_info.id == "whisper"
    assert manager.engine_info.gpu_vram_gb == pytest.approx(6.0)
    assert manager.engine_info.estimated_max_duration_s is not None


def test_factory_respects_manual_nemotron_on_low_vram(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(engine="nemotron", engine_preference_mode="manual")
    created_engine_ids: list[str] = []

    monkeypatch.setattr(factory_module, "_get_available_engine_ids", lambda: ["nemotron", "whisper"])
    monkeypatch.setattr(
        factory_module,
        "detect_gpu_capabilities",
        lambda _device: GpuCapabilities(
            cuda_available=True,
            device="cuda",
            device_index=0,
            name="Test GPU",
            total_vram_gb=6.0,
        ),
    )

    def _fake_create_engine(current_settings: Settings) -> _DummyEngine:
        created_engine_ids.append(current_settings.engine)
        return _DummyEngine(current_settings.engine)

    monkeypatch.setattr(factory_module, "_create_engine", _fake_create_engine)

    manager = factory_module.EngineManager(settings)
    manager.load_initial_engine()

    assert settings.engine == "nemotron"
    assert created_engine_ids == ["nemotron"]
    assert manager.engine_info.id == "nemotron"
    assert manager.engine_info.gpu_vram_gb == pytest.approx(6.0)
    assert manager.engine_info.estimated_max_duration_s is not None


class _FakeAudioBuffer:
    duration_seconds = 3.2

    def get_audio_float32(self) -> np.ndarray:
        return np.array([0.1, 0.2, 0.3], dtype=np.float32)


class _FakeSession:
    def __init__(self) -> None:
        self._last = TranscribeResult(text="last good", confidence=0.93, last_speech_end=2.8)

    def transcribe(
        self,
        _audio: np.ndarray,
        *,
        hotwords: str | None = None,
    ) -> TranscribeResult:
        raise VramExhaustedError(last_result=self._last)

    def finalize(self) -> TranscribeResult:
        return self._last

    def close(self) -> None:
        return


class _FakeManager:
    def __init__(self, session: _FakeSession) -> None:
        self._session = session

    def create_session(self, _session_id: str) -> _FakeSession:
        return self._session

    def release_session(self, _session_id: str) -> None:
        return


@pytest.mark.asyncio
async def test_transcribe_final_returns_last_result_after_vram_oom(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_session = _FakeSession()
    fake_manager = _FakeManager(fake_session)

    monkeypatch.setattr(processor_module, "get_settings", lambda: SimpleNamespace(min_audio_for_transcription=0.1))
    monkeypatch.setattr(processor_module, "get_engine_manager", lambda: fake_manager)

    context = SimpleNamespace(
        session_id="test-session",
        audio_buffer=_FakeAudioBuffer(),
        hotwords=None,
        last_partial_text="",
    )
    processor = processor_module.TranscriptionProcessor(context)

    result = await processor.transcribe_final()

    assert result.text == "last good"
    assert result.confidence == pytest.approx(0.93)
    assert result.last_speech_end == pytest.approx(2.8)
