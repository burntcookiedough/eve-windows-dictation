"""Runtime dependency diagnostics for GPU and Windows prerequisites."""

from __future__ import annotations

import ctypes
import csv
import io
import importlib
import sys
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from config import Settings
from runtime_paths import gpu_runtime_allowed
from transcription.vram import _get_nvidia_smi_output, detect_gpu_capabilities

MIN_NVIDIA_DRIVER_VERSION = "525.0"
NVIDIA_DRIVER_URL = "https://www.nvidia.com/Download/index.aspx"
VC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"

_DIAGNOSTICS_CACHE_TTL_S = 30.0
_last_diagnostics: dict[str, Any] | None = None
_last_collected_at: float | None = None
_last_signature: tuple[str, str] | None = None
_diagnostics_cache_lock = threading.Lock()
_diagnostics_refresh_lock = threading.Lock()


@dataclass(frozen=True)
class DiagnosticWarning:
    code: str
    message: str
    action: str | None = None
    url: str | None = None
    severity: str = "warning"


@dataclass(frozen=True)
class CudaDiagnostics:
    available: bool
    device: str
    reason: str | None = None
    name: str | None = None
    compute_capability: str | None = None


@dataclass(frozen=True)
class CudaDllDiagnostics:
    available: bool
    detail: str | None = None


@dataclass(frozen=True)
class NvidiaDriverDiagnostics:
    available: bool
    version: str | None = None
    minimum_version: str | None = None
    meets_minimum: bool | None = None


@dataclass(frozen=True)
class VcRedistDiagnostics:
    required: bool
    installed: bool | None = None
    missing: list[str] | None = None
    url: str | None = None


@dataclass(frozen=True)
class DiagnosticsPayload:
    generated_at: str
    cuda: CudaDiagnostics
    cuda_dlls: CudaDllDiagnostics
    nvidia_driver: NvidiaDriverDiagnostics
    vc_redist: VcRedistDiagnostics
    warnings: list[DiagnosticWarning]


def _load_ctranslate2() -> Any:
    return importlib.import_module("ctranslate2")


def _load_windows_dll(name: str) -> Any:
    return ctypes.WinDLL(name)


def _run_nvidia_smi() -> str | None:
    return _get_nvidia_smi_output()


def _parse_driver_version(raw: str) -> tuple[int, int, int] | None:
    parts = [p for p in raw.strip().split(".") if p]
    numbers: list[int] = []
    for part in parts:
        if part.isdigit():
            numbers.append(int(part))
        else:
            digits = "".join(ch for ch in part if ch.isdigit())
            if digits:
                numbers.append(int(digits))
            else:
                return None
    if not numbers:
        return None
    while len(numbers) < 3:
        numbers.append(0)
    return numbers[0], numbers[1], numbers[2]


def _version_tuple(version: str) -> tuple[int, int, int] | None:
    return _parse_driver_version(version)


def _get_whisper_device(settings: Settings) -> str:
    effective = getattr(settings, "effective_whisper_config", None)
    if effective is not None:
        return effective.requested_device
    return settings.whisper_device


def check_cuda_capability(device: str) -> CudaDiagnostics:
    capabilities = detect_gpu_capabilities(device)

    return CudaDiagnostics(
        available=capabilities.cuda_available,
        device=capabilities.device,
        reason=capabilities.reason,
        name=capabilities.name,
        # CTranslate2 does not expose the CUDA compute capability, and this
        # diagnostic deliberately does not import another GPU framework.
        compute_capability=None,
    )


def check_ctranslate2_cuda_dlls() -> CudaDllDiagnostics:
    if not gpu_runtime_allowed():
        return CudaDllDiagnostics(
            available=False,
            detail="The optional GPU runtime is not installed.",
        )
    try:
        ctranslate2 = _load_ctranslate2()
    except Exception:
        return CudaDllDiagnostics(
            available=False,
            detail="CTranslate2 runtime is unavailable.",
        )

    try:
        device_count = ctranslate2.get_cuda_device_count()
    except Exception:
        return CudaDllDiagnostics(
            available=False,
            detail="CTranslate2 CUDA device query failed.",
        )
    if device_count < 1:
        return CudaDllDiagnostics(
            available=False,
            detail="CTranslate2 did not find a CUDA device.",
        )

    try:
        compute_types = ctranslate2.get_supported_compute_types("cuda")
    except Exception:
        return CudaDllDiagnostics(
            available=False,
            detail="CTranslate2 CUDA compute-type query failed.",
        )
    if not compute_types:
        return CudaDllDiagnostics(
            available=False,
            detail="CTranslate2 reports no supported CUDA compute types.",
        )
    return CudaDllDiagnostics(
        available=True,
        detail=(
            "CTranslate2 reports CUDA compute support; this diagnostic did not "
            "test Whisper model loading or transcription."
        ),
    )


def check_nvidia_driver() -> NvidiaDriverDiagnostics:
    output = _run_nvidia_smi()
    minimum_version = MIN_NVIDIA_DRIVER_VERSION
    if not output:
        return NvidiaDriverDiagnostics(
            available=False,
            version=None,
            minimum_version=minimum_version,
            meets_minimum=None,
        )

    versions: list[str] = []
    for row in csv.reader(io.StringIO(output)):
        if not row:
            continue
        # Accept a legacy driver-only line as well as the shared CSV query.
        version_column = 1 if len(row) >= 4 else 0
        version = row[version_column].strip()
        if version:
            versions.append(version)
    if not versions:
        return NvidiaDriverDiagnostics(
            available=False,
            version=None,
            minimum_version=minimum_version,
            meets_minimum=None,
        )

    parsed_versions = [v for v in (_version_tuple(v) for v in versions) if v is not None]
    if not parsed_versions:
        return NvidiaDriverDiagnostics(
            available=True,
            version=versions[0],
            minimum_version=minimum_version,
            meets_minimum=None,
        )

    min_detected = min(parsed_versions)
    minimum_tuple = _version_tuple(minimum_version)
    meets_minimum = None
    if minimum_tuple is not None:
        meets_minimum = min_detected >= minimum_tuple

    return NvidiaDriverDiagnostics(
        available=True,
        version=versions[0],
        minimum_version=minimum_version,
        meets_minimum=meets_minimum,
    )


def check_vc_redist() -> VcRedistDiagnostics:
    if sys.platform != "win32":
        return VcRedistDiagnostics(required=False, installed=None, missing=None, url=None)

    required_dlls = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"]
    missing: list[str] = []

    for dll in required_dlls:
        try:
            _load_windows_dll(dll)
        except OSError:
            missing.append(dll)

    installed = len(missing) == 0

    return VcRedistDiagnostics(
        required=True,
        installed=installed,
        missing=missing if not installed else [],
        url=VC_REDIST_URL,
    )


def build_warnings(
    *,
    device: str,
    cuda: CudaDiagnostics,
    cuda_dlls: CudaDllDiagnostics,
    driver: NvidiaDriverDiagnostics,
    vc_redist: VcRedistDiagnostics,
) -> list[DiagnosticWarning]:
    warnings: list[DiagnosticWarning] = []

    if vc_redist.required and vc_redist.installed is False:
        warnings.append(
            DiagnosticWarning(
                code="vc_redist_missing",
                message="Microsoft Visual C++ Redistributable is required for Eve to run.",
                action="Install the Visual C++ Redistributable (x64), then restart Eve.",
                url=vc_redist.url,
            )
        )

    expects_cuda = device != "cpu"
    if expects_cuda:
        if device == "cuda" and not cuda.available:
            message = "CUDA was requested but is not available."
            if cuda.reason:
                message = f"CUDA was requested but is not available: {cuda.reason}."
            warnings.append(
                DiagnosticWarning(
                    code="cuda_unavailable",
                    message=message,
                    action="Install a compatible NVIDIA driver or switch to CPU mode in Settings > Server.",
                )
            )

        if (device == "cuda" or cuda.available) and not cuda_dlls.available:
            warnings.append(
                DiagnosticWarning(
                    code="cuda_dll_missing",
                    message="CTranslate2 did not confirm CUDA runtime support.",
                    action=(
                        "Check the CTranslate2 CUDA runtime and compatible NVIDIA driver, "
                        "or switch to CPU mode in Settings > Server."
                    ),
                    url=NVIDIA_DRIVER_URL,
                )
            )

        if driver.meets_minimum is False:
            version = driver.version or "unknown"
            minimum = driver.minimum_version or MIN_NVIDIA_DRIVER_VERSION
            warnings.append(
                DiagnosticWarning(
                    code="nvidia_driver_old",
                    message=f"NVIDIA driver {version} is below the required {minimum}.",
                    action="Update your NVIDIA driver and restart Eve.",
                    url=NVIDIA_DRIVER_URL,
                )
            )

    return warnings


def _get_cached_diagnostics(
    signature: tuple[str, str],
    *,
    fresh_only: bool,
) -> dict[str, Any] | None:
    with _diagnostics_cache_lock:
        if (
            _last_diagnostics is None
            or _last_collected_at is None
            or _last_signature != signature
        ):
            return None
        if fresh_only and time.time() - _last_collected_at >= _DIAGNOSTICS_CACHE_TTL_S:
            return None
        return _last_diagnostics


def _diagnostics_refreshing_payload(settings: Settings) -> dict[str, Any]:
    detail = "Runtime diagnostics refresh is in progress."
    payload = DiagnosticsPayload(
        generated_at=datetime.now(timezone.utc).isoformat(),
        cuda=CudaDiagnostics(
            available=False,
            device=_get_whisper_device(settings),
            reason=detail,
        ),
        cuda_dlls=CudaDllDiagnostics(available=False, detail=detail),
        nvidia_driver=NvidiaDriverDiagnostics(
            available=False,
            version=None,
            minimum_version=MIN_NVIDIA_DRIVER_VERSION,
            meets_minimum=None,
        ),
        vc_redist=VcRedistDiagnostics(
            required=sys.platform == "win32",
            installed=None,
            missing=None,
            url=VC_REDIST_URL if sys.platform == "win32" else None,
        ),
        warnings=[
            DiagnosticWarning(
                code="diagnostics_refreshing",
                message=detail,
                action="Retry shortly.",
                severity="warning",
            )
        ],
    )
    return {
        "generated_at": payload.generated_at,
        "cuda": asdict(payload.cuda),
        "cuda_dlls": asdict(payload.cuda_dlls),
        "nvidia_driver": asdict(payload.nvidia_driver),
        "vc_redist": asdict(payload.vc_redist),
        "warnings": [asdict(warning) for warning in payload.warnings],
    }


def collect_diagnostics(settings: Settings, *, force: bool = False) -> dict[str, Any]:
    global _last_diagnostics, _last_collected_at, _last_signature

    requested_device = _get_whisper_device(settings)
    effective_device = settings.whisper_device
    signature = (requested_device, effective_device)

    if not force:
        cached = _get_cached_diagnostics(signature, fresh_only=True)
        if cached is not None:
            return cached

    if not _diagnostics_refresh_lock.acquire(blocking=False):
        cached = _get_cached_diagnostics(signature, fresh_only=False)
        return cached if cached is not None else _diagnostics_refreshing_payload(settings)

    try:
        if not force:
            cached = _get_cached_diagnostics(signature, fresh_only=True)
            if cached is not None:
                return cached

        now = time.time()
        device = requested_device
        cuda = check_cuda_capability(device)
        cuda_dlls = check_ctranslate2_cuda_dlls()
        driver = check_nvidia_driver()
        vc_redist = check_vc_redist()
        warnings = build_warnings(
            device=device,
            cuda=cuda,
            cuda_dlls=cuda_dlls,
            driver=driver,
            vc_redist=vc_redist,
        )

        payload = DiagnosticsPayload(
            generated_at=datetime.now(timezone.utc).isoformat(),
            cuda=cuda,
            cuda_dlls=cuda_dlls,
            nvidia_driver=driver,
            vc_redist=vc_redist,
            warnings=warnings,
        )

        serialized = {
            "generated_at": payload.generated_at,
            "cuda": asdict(payload.cuda),
            "cuda_dlls": asdict(payload.cuda_dlls),
            "nvidia_driver": asdict(payload.nvidia_driver),
            "vc_redist": asdict(payload.vc_redist),
            "warnings": [asdict(warning) for warning in payload.warnings],
        }

        with _diagnostics_cache_lock:
            _last_diagnostics = serialized
            _last_collected_at = now
            _last_signature = signature

        return serialized
    finally:
        _diagnostics_refresh_lock.release()
