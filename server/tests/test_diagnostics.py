"""Diagnostics helpers and payload tests."""

from __future__ import annotations

import sys

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
