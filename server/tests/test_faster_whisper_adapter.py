"""Contract tests for the Faster-Whisper adapter boundary."""

from __future__ import annotations

from types import SimpleNamespace

from config import Settings
from transcription.base import EngineInfo
from transcription.contracts import ModelId, WhisperConfig
import transcription.faster_whisper_adapter as adapter_module
from transcription.faster_whisper_adapter import FasterWhisperAdapter
from transcription.vram import GpuCapabilities


def _config() -> WhisperConfig:
    return WhisperConfig(
        model=ModelId("medium"),
        device="cuda",
        compute_type="float16",
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


def test_adapter_maps_legacy_engine_info_and_preserves_full_whisper_options(monkeypatch) -> None:
    observed: list[object] = []

    class FakeEngine:
        def __init__(self, settings) -> None:
            observed.append(settings)
            self.engine_info = EngineInfo(
                id="whisper",
                name="Faster-Whisper",
                model="medium",
                supports_hotwords=True,
                languages=["en", "de"],
                model_size_gb=1.4,
                repo_id="Systran/faster-whisper-medium",
                model_path="C:/cache/medium",
                device="cuda",
                compute_type="float16",
                cuda_active=True,
                load_time_s=1.25,
                gpu_name="Test GPU",
                gpu_vram_gb=8.0,
                estimated_max_duration_s=240,
                last_transcription_latency_s=0.03,
                vram_used_gb=2.2,
            )

        def create_session(self):
            return SimpleNamespace(close=lambda: None)

        def shutdown(self):
            return None

    monkeypatch.setattr(adapter_module, "WhisperEngine", FakeEngine)
    events = []
    prepared = FasterWhisperAdapter().prepare(_config(), events.append)

    assert [event.phase for event in events] == ["preparing", "ready"]
    assert prepared.info.model == ModelId("medium")
    assert prepared.info.supports_hotwords is True
    assert prepared.info.gpu_name == "Test GPU"
    assert prepared.info.gpu_vram_gb == 8.0
    assert prepared.info.estimated_max_duration_s == 240
    assert prepared.info.vram_used_gb == 2.2
    assert prepared.info.last_transcription_latency_s == 0.03
    settings = observed[0]
    assert settings.whisper_language == "de"
    assert settings.whisper_beam_size == 3
    assert settings.whisper_condition_on_previous_text is True
    assert settings.whisper_without_timestamps is False
    assert settings.whisper_vad_min_silence_duration_ms == 900
    assert settings.whisper_vad_speech_pad_ms == 320
    assert settings.whisper_vad_threshold == 0.65


def test_adapter_accepts_explicit_custom_model_sources_without_catalog_allowlist(monkeypatch) -> None:
    class FakeEngine:
        def __init__(self, settings) -> None:
            self.engine_info = EngineInfo(
                id="whisper",
                name="Faster-Whisper",
                model=settings.whisper_model,
                supports_hotwords=True,
            )

        def create_session(self):
            return SimpleNamespace(close=lambda: None)

        def shutdown(self):
            return None

    monkeypatch.setattr(adapter_module, "WhisperEngine", FakeEngine)
    config = WhisperConfig(model=ModelId("org/private-whisper"))
    prepared = FasterWhisperAdapter().prepare(config, lambda _event: None)

    assert prepared.info.model == ModelId("org/private-whisper")


def test_adapter_restores_gpu_and_duration_telemetry_when_engine_info_is_sparse(monkeypatch) -> None:
    class FakeEngine:
        def __init__(self, settings) -> None:
            self.engine_info = EngineInfo(
                id="whisper",
                name="Faster-Whisper",
                model=settings.whisper_model,
                supports_hotwords=True,
                device="cuda",
            )

        def create_session(self):
            return SimpleNamespace(close=lambda: None)

        def shutdown(self):
            return None

    monkeypatch.setattr(adapter_module, "WhisperEngine", FakeEngine)
    monkeypatch.setattr(
        adapter_module,
        "detect_gpu_capabilities",
        lambda _device: GpuCapabilities(True, "cuda", 0, "Measured GPU", 12.0),
    )
    monkeypatch.setattr(adapter_module, "estimate_max_duration_s", lambda _engine, _vram: 321)

    prepared = FasterWhisperAdapter().prepare(_config(), lambda _event: None)

    assert prepared.info.gpu_name == "Measured GPU"
    assert prepared.info.gpu_vram_gb == 12.0
    assert prepared.info.estimated_max_duration_s == 321
