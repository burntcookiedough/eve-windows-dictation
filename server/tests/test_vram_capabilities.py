"""Torch-free CTranslate2 GPU capability checks."""

from __future__ import annotations

import builtins
import sys
from types import SimpleNamespace

import runtime_paths
import transcription.vram as vram


def test_detect_gpu_capabilities_uses_ctranslate2_and_nvidia_smi_without_torch(
    monkeypatch,
) -> None:
    calls: list[tuple[str, int]] = []
    torch_imports: list[str] = []
    original_import = builtins.__import__

    def import_without_torch(name, *args, **kwargs):
        if name == "torch" or name.startswith("torch."):
            torch_imports.append(name)
            raise AssertionError("GPU metadata must not require PyTorch")
        return original_import(name, *args, **kwargs)

    def supported_compute_types(device: str, device_index: int) -> set[str]:
        calls.append((device, device_index))
        return {"float16"}

    monkeypatch.setattr(builtins, "__import__", import_without_torch)
    monkeypatch.setattr(vram, "_nvidia_smi_cached_at", None)
    monkeypatch.setattr(vram, "_nvidia_smi_cached_output", None)
    monkeypatch.setitem(
        sys.modules,
        "ctranslate2",
        SimpleNamespace(
            get_cuda_device_count=lambda: 2,
            get_supported_compute_types=supported_compute_types,
        ),
    )
    monkeypatch.setattr(
        vram.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            stdout="0, 551.86, First GPU, 16384\n1, 551.86, Second GPU, 8192\n"
        ),
    )

    capabilities = vram.detect_gpu_capabilities("cuda:1")

    assert capabilities.cuda_available is True
    assert capabilities.device_index == 1
    assert capabilities.name == "Second GPU"
    assert capabilities.total_vram_gb == 8.0
    assert capabilities.reason is None
    assert calls == [("cuda", 1)]
    assert torch_imports == []


def test_detect_gpu_capabilities_does_not_trust_device_count_alone(monkeypatch) -> None:
    monkeypatch.setitem(
        sys.modules,
        "ctranslate2",
        SimpleNamespace(
            get_cuda_device_count=lambda: 1,
            get_supported_compute_types=lambda *_args: set(),
        ),
    )

    capabilities = vram.detect_gpu_capabilities("cuda")

    assert capabilities.cuda_available is False
    assert capabilities.reason == "CTranslate2 reports no supported CUDA compute types"
    assert capabilities.name is None
    assert capabilities.total_vram_gb is None


def test_packaged_cpu_diagnostics_ignore_system_cuda_without_pack(monkeypatch) -> None:
    monkeypatch.setenv("MURMUR_APP_BUILD_ID", "0.8.2-alpha.5")
    monkeypatch.setattr(runtime_paths, "_ACTIVE_GPU_RUNTIME_DIR", None)
    monkeypatch.setitem(
        sys.modules,
        "ctranslate2",
        SimpleNamespace(
            get_cuda_device_count=lambda: (_ for _ in ()).throw(
                AssertionError("CPU build must not probe system CUDA")
            ),
        ),
    )

    capabilities = vram.detect_gpu_capabilities("auto")

    assert capabilities.cuda_available is False
    assert capabilities.reason == "The optional GPU runtime is not installed."


def test_detect_gpu_capabilities_rejects_invalid_cuda_index() -> None:
    capabilities = vram.detect_gpu_capabilities("cuda:-1")

    assert capabilities.cuda_available is False
    assert capabilities.device_index is None
    assert capabilities.reason == "Unsupported CUDA device selector: 'cuda:-1'"
