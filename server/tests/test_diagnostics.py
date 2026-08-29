"""Diagnostics helpers and payload tests."""

from __future__ import annotations

import math
import subprocess
import sys
import threading

from config import Settings
import diagnostics
from diagnostics import (
    CudaDiagnostics,
    CudaDllDiagnostics,
    NvidiaDriverDiagnostics,
    VcRedistDiagnostics,
    build_warnings,
)


def test_parse_driver_version_handles_patch() -> None:
    assert diagnostics._parse_driver_version("551.86") == (551, 86, 0)


def test_run_nvidia_smi_timeout_returns_unavailable(monkeypatch) -> None:
    calls: dict[str, object] = {}

    def raise_timeout(*args, **kwargs):
        calls.update(kwargs)
        raise subprocess.TimeoutExpired(args[0], timeout=kwargs["timeout"])

    monkeypatch.setattr(diagnostics.subprocess, "run", raise_timeout)

    assert diagnostics._run_nvidia_smi() is None
    timeout = calls.get("timeout")
    assert isinstance(timeout, (int, float))
    assert math.isfinite(timeout)
    assert timeout > 0


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

    settings = Settings()
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
        incompatible_settings = Settings(whisper_device="cpu")
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
