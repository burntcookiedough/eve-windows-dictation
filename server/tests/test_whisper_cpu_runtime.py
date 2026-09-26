"""Focused checks for Torch-free Whisper setup and CTranslate2 cleanup."""

from __future__ import annotations

import builtins
import importlib
from pathlib import Path
from types import SimpleNamespace

from config import Settings
import transcription.engines.whisper as whisper


def test_whisper_engine_module_imports_without_importing_torch(monkeypatch) -> None:
    original_import = builtins.__import__
    torch_imports: list[str] = []

    def import_without_torch(name, *args, **kwargs):
        if name == "torch" or name.startswith("torch."):
            torch_imports.append(name)
            raise AssertionError("the CPU runtime must not import PyTorch")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_without_torch)

    importlib.reload(whisper)

    assert torch_imports == []


def test_whisper_shutdown_unloads_ctranslate2_model_and_reports_actual_device(
    tmp_path: Path,
    monkeypatch,
) -> None:
    model_path = tmp_path / "local-model"
    model_path.mkdir()
    unload_calls: list[None] = []

    class FakeWhisperModel:
        def __init__(self, *_args, **_kwargs) -> None:
            self.model = SimpleNamespace(
                device="cuda",
                unload_model=lambda: unload_calls.append(None),
            )

    monkeypatch.setattr(whisper, "WhisperModel", FakeWhisperModel)
    monkeypatch.setattr(whisper, "_get_vram_used_gb", lambda: None)
    engine = whisper.WhisperEngine(
        Settings(
            whisper_model=str(model_path),
            whisper_device="cuda",
            whisper_compute_type="float16",
        )
    )

    assert engine.engine_info.cuda_active is True
    engine.shutdown()
    assert unload_calls == [None]
