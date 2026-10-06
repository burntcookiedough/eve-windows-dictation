"""Diagnostics helpers and payload tests."""

from __future__ import annotations

import builtins
import math
import subprocess
import sys
import threading
from types import SimpleNamespace

import config
from config import Settings
import diagnostics
from engine_compatibility import ComputeCapability, RuntimeCapabilities
from transcription.vram import GpuCapabilities
from diagnostics import (
    CudaDiagnostics,
    CudaDllDiagnostics,
    NvidiaDriverDiagnostics,
    VcRedistDiagnostics,
    build_warnings,
)
import transcription.vram as vram


def test_parse_driver_version_handles_patch() -> None:
    assert diagnostics._parse_driver_version("551.86") == (551, 86, 0)


def test_run_nvidia_smi_timeout_returns_unavailable(monkeypatch) -> None:
    calls: dict[str, object] = {}

    def raise_timeout(*args, **kwargs):
        calls.update(kwargs)
        raise subprocess.TimeoutExpired(args[0], timeout=kwargs["timeout"])

    monkeypatch.setattr(vram, "_nvidia_smi_cached_at", None)
    monkeypatch.setattr(vram, "_nvidia_smi_cached_output", None)
    monkeypatch.setattr(vram.subprocess, "run", raise_timeout)

    assert diagnostics._run_nvidia_smi() is None
    timeout = calls.get("timeout")
    assert isinstance(timeout, (int, float))
    assert math.isfinite(timeout)
    assert timeout > 0


def test_gpu_metadata_and_driver_diagnostics_share_one_nvidia_smi_call(monkeypatch) -> None:
    calls: list[list[str]] = []

    def run_nvidia_smi(args, **_kwargs):
        calls.append(args)
        return SimpleNamespace(stdout="0, 551.86, Test GPU, 8192\n")

    monkeypatch.setattr(vram, "_nvidia_smi_cached_at", None)
    monkeypatch.setattr(vram, "_nvidia_smi_cached_output", None)
    monkeypatch.setattr(vram.subprocess, "run", run_nvidia_smi)
    monkeypatch.setitem(
        sys.modules,
        "ctranslate2",
        SimpleNamespace(
            get_cuda_device_count=lambda: 1,
            get_supported_compute_types=lambda _device, _index=0: {"float16"},
        ),
    )

    capabilities = vram.detect_gpu_capabilities("cuda")
    driver = diagnostics.check_nvidia_driver()

    assert capabilities.name == "Test GPU"
    assert capabilities.total_vram_gb == 8.0
    assert driver.version == "551.86"
    assert calls == [[
        "nvidia-smi",
        "--query-gpu=index,driver_version,name,memory.total",
        "--format=csv,noheader,nounits",
    ]]


def test_check_vc_redist_reports_missing_dlls(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")

    missing = {"vcruntime140.dll", "msvcp140.dll"}

    def fake_load(dll: str) -> object:
        if dll in missing:
            raise OSError("missing")
        return object()

    monkeypatch.setattr(diagnostics, "_load_windows_dll", fake_load)

    result = diagnostics.check_vc_redist()
    assert result.required is True
    assert result.installed is False
    assert set(result.missing or []) == missing


def test_build_warnings_includes_expected_codes() -> None:
    warnings = build_warnings(
        device="cuda",
        cuda=CudaDiagnostics(
            available=True,
            device="cuda",
            reason=None,
            name="RTX",
            compute_capability="8.6",
        ),
        cuda_dlls=CudaDllDiagnostics(available=False, detail="missing dll"),
        driver=NvidiaDriverDiagnostics(
            available=True,
            version="520.10",
            minimum_version="525.0",
            meets_minimum=False,
        ),
        vc_redist=VcRedistDiagnostics(required=True, installed=False, missing=["vcruntime140.dll"], url="x"),
    )
    codes = {warning.code for warning in warnings}
    assert "vc_redist_missing" in codes
    assert "cuda_dll_missing" in codes
    assert "nvidia_driver_old" in codes
    by_code = {warning.code: warning for warning in warnings}
    vc_redist = by_code["vc_redist_missing"]
    assert vc_redist.message == "Microsoft Visual C++ Redistributable is required for Eve to run."
    assert vc_redist.action == "Install the Visual C++ Redistributable (x64), then restart Eve."
    assert vc_redist.url == "x"
    assert vc_redist.severity == "warning"
    driver = by_code["nvidia_driver_old"]
    assert driver.action == "Update your NVIDIA driver and restart Eve."
    assert driver.url == diagnostics.NVIDIA_DRIVER_URL
    assert driver.severity == "warning"
    assert all("murmur" not in f"{warning.message} {warning.action}".lower() for warning in warnings)


def test_collect_diagnostics_payload_shape(monkeypatch) -> None:
    monkeypatch.setattr(
        diagnostics,
        "check_cuda_capability",
        lambda device: CudaDiagnostics(
            available=True,
            device=device,
            reason=None,
            name="GPU",
            compute_capability="8.6",
        ),
    )
    monkeypatch.setattr(
        diagnostics,
        "check_ctranslate2_cuda_dlls",
        lambda: CudaDllDiagnostics(available=True, detail=None),
    )
    monkeypatch.setattr(
        diagnostics,
        "check_nvidia_driver",
        lambda: NvidiaDriverDiagnostics(
            available=True,
            version="551.86",
            minimum_version="525.0",
            meets_minimum=True,
        ),
    )
    monkeypatch.setattr(
        diagnostics,
        "check_vc_redist",
        lambda: VcRedistDiagnostics(required=False, installed=None, missing=None, url=None),
    )

    payload = diagnostics.collect_diagnostics(Settings(), force=True)
    assert "warnings" in payload
    assert "cuda" in payload
    assert "cuda_dlls" in payload
    assert "nvidia_driver" in payload
    assert "vc_redist" in payload
    assert isinstance(payload["warnings"], list)


def test_collect_diagnostics_warns_when_saved_cuda_preference_falls_back_to_cpu(
    monkeypatch,
) -> None:
    capabilities = RuntimeCapabilities(
        whisper_cpu=ComputeCapability(frozenset({"int8", "float32"})),
        whisper_cuda=ComputeCapability(None, "The optional GPU runtime is not installed."),
    )
    monkeypatch.setattr(config, "get_runtime_capabilities", lambda: capabilities)
    checked_devices: list[str] = []

    def check_cuda(device: str) -> CudaDiagnostics:
        checked_devices.append(device)
        available = device == "cuda" and capabilities.whisper_cuda_available
        return CudaDiagnostics(
            available=available,
            device=device,
            reason=None if available else "The optional GPU runtime is not installed.",
            name="Test GPU" if available else None,
            compute_capability=None,
        )

    monkeypatch.setattr(diagnostics, "check_cuda_capability", check_cuda)
    monkeypatch.setattr(
        diagnostics,
        "check_ctranslate2_cuda_dlls",
        lambda: CudaDllDiagnostics(available=False, detail="GPU runtime missing"),
    )
    monkeypatch.setattr(
        diagnostics,
        "check_nvidia_driver",
        lambda: NvidiaDriverDiagnostics(
            available=False,
            version=None,
            minimum_version="525.0",
            meets_minimum=None,
        ),
    )
    monkeypatch.setattr(
        diagnostics,
        "check_vc_redist",
        lambda: VcRedistDiagnostics(required=False, installed=None, missing=None, url=None),
    )
    settings = Settings(whisper_device="cuda")

    payload = diagnostics.collect_diagnostics(settings, force=True)

    assert settings.whisper_device == "cpu"
    assert settings.effective_whisper_config is not None
    assert settings.effective_whisper_config.requested_device == "cuda"
    assert checked_devices == ["cuda"]
    assert any(warning["code"] == "cuda_unavailable" for warning in payload["warnings"])

    capabilities = RuntimeCapabilities(
        whisper_cpu=ComputeCapability(frozenset({"int8", "float32"})),
        whisper_cuda=ComputeCapability(frozenset({"float16"})),
    )
    cuda_settings = Settings(whisper_device="cuda")
    cuda_payload = diagnostics.collect_diagnostics(cuda_settings)

    assert cuda_settings.whisper_device == "cuda"
    assert checked_devices == ["cuda", "cuda"]
    assert cuda_payload["cuda"]["available"] is True
    assert not any(
        warning["code"] == "cuda_unavailable" for warning in cuda_payload["warnings"]
    )

    cpu_settings = Settings(whisper_device="cpu")
    cpu_payload = diagnostics.collect_diagnostics(cpu_settings)

    assert checked_devices == ["cuda", "cuda", "cpu"]
    assert not any(
        warning["code"] == "cuda_unavailable" for warning in cpu_payload["warnings"]
    )


def test_check_cuda_capability_never_imports_torch(monkeypatch) -> None:
    torch_imports: list[str] = []
    original_import = builtins.__import__

    def import_without_torch(name, *args, **kwargs):
        if name == "torch" or name.startswith("torch."):
            torch_imports.append(name)
            raise AssertionError("diagnostics must not require PyTorch")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_without_torch)
    monkeypatch.setattr(
        diagnostics,
        "detect_gpu_capabilities",
        lambda device: GpuCapabilities(True, device, 0, "Test GPU", 8.0),
    )

    result = diagnostics.check_cuda_capability("cuda")

    assert result.available is True
    assert result.name == "Test GPU"
    assert result.compute_capability is None
    assert torch_imports == []


def test_check_ctranslate2_cuda_dlls_requires_compute_types(monkeypatch) -> None:
    monkeypatch.setattr(
        diagnostics,
        "_load_ctranslate2",
        lambda: SimpleNamespace(
            get_cuda_device_count=lambda: 1,
            get_supported_compute_types=lambda _device: set(),
        ),
    )

    result = diagnostics.check_ctranslate2_cuda_dlls()

    assert result.available is False
    assert result.detail == "CTranslate2 reports no supported CUDA compute types."


def test_packaged_cpu_diagnostics_do_not_probe_ambient_cuda(monkeypatch) -> None:
    monkeypatch.setattr(diagnostics, "gpu_runtime_allowed", lambda: False)
    monkeypatch.setattr(
        diagnostics,
        "_load_ctranslate2",
        lambda: (_ for _ in ()).throw(AssertionError("CUDA was probed")),
    )

    result = diagnostics.check_ctranslate2_cuda_dlls()

    assert result.available is False
    assert result.detail == "The optional GPU runtime is not installed."


def test_check_ctranslate2_cuda_dlls_discloses_that_it_did_not_test_inference(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        diagnostics,
        "_load_ctranslate2",
        lambda: SimpleNamespace(
            get_cuda_device_count=lambda: 1,
            get_supported_compute_types=lambda _device: {"float16"},
        ),
    )

    result = diagnostics.check_ctranslate2_cuda_dlls()

    assert result.available is True
    assert result.detail is not None
    assert "did not test Whisper model loading or transcription" in result.detail


def test_collect_diagnostics_does_not_wait_behind_concurrent_cache_refresh(monkeypatch) -> None:
    probe_started = threading.Event()
    release_probe = threading.Event()
    contenders_finished = threading.Event()
    probe_calls = 0
    results: dict[str, dict] = {}
    stall_probe = False

    monkeypatch.setattr(diagnostics, "_last_diagnostics", None)
    monkeypatch.setattr(diagnostics, "_last_collected_at", None)
    monkeypatch.setattr(diagnostics, "_last_signature", None)

    def check_cuda(device: str) -> CudaDiagnostics:
        nonlocal probe_calls, stall_probe
        probe_calls += 1
        if stall_probe:
            probe_started.set()
            if not release_probe.wait(timeout=2):
                raise AssertionError("diagnostics probe was not released")
        return CudaDiagnostics(
            available=True,
            device=device,
            reason=None,
            name="GPU",
            compute_capability="8.6",
        )

    monkeypatch.setattr(diagnostics, "check_cuda_capability", check_cuda)
    monkeypatch.setattr(
        diagnostics,
        "check_ctranslate2_cuda_dlls",
        lambda: CudaDllDiagnostics(available=True, detail=None),
    )
    monkeypatch.setattr(
        diagnostics,
        "check_nvidia_driver",
        lambda: NvidiaDriverDiagnostics(
            available=True,
            version="551.86",
            minimum_version="525.0",
            meets_minimum=True,
        ),
    )
    monkeypatch.setattr(
        diagnostics,
        "check_vc_redist",
        lambda: VcRedistDiagnostics(
            required=False,
            installed=None,
            missing=None,
            url=None,
        ),
    )

    # Cache-key behavior must not depend on whether the CI host has a GPU.
    settings = Settings.model_construct(whisper_device="auto")
    cached = diagnostics.collect_diagnostics(settings, force=True)
    stall_probe = True
    first = threading.Thread(
        target=lambda: results.__setitem__(
            "first", diagnostics.collect_diagnostics(settings, force=True)
        )
    )

    def collect_contenders() -> None:
        results["compatible"] = diagnostics.collect_diagnostics(
            settings, force=True
        )
        incompatible_settings = Settings.model_construct(whisper_device="cpu")
        results["incompatible"] = diagnostics.collect_diagnostics(
            incompatible_settings, force=True
        )
        contenders_finished.set()

    contenders = threading.Thread(target=collect_contenders)
    first.start()
    assert probe_started.wait(timeout=1)
    contenders.start()
    contenders_finished_before_release = contenders_finished.wait(timeout=1)
    release_probe.set()
    first.join(timeout=2)
    contenders.join(timeout=2)

    assert contenders_finished_before_release
    assert not first.is_alive()
    assert not contenders.is_alive()
    assert probe_calls == 2
    assert len(results) == 3
    assert results["compatible"] is cached
    assert results["incompatible"]["warnings"][0]["code"] == "diagnostics_refreshing"
    assert results["incompatible"]["warnings"][0]["severity"] == "warning"
    assert diagnostics.collect_diagnostics(settings) is results["first"]
