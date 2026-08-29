"""Runtime dependency diagnostics for GPU and Windows prerequisites."""

from __future__ import annotations

import ctypes
import importlib
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from config import Settings
from transcription.vram import detect_gpu_capabilities

MIN_NVIDIA_DRIVER_VERSION = "525.0"
NVIDIA_DRIVER_URL = "https://www.nvidia.com/Download/index.aspx"
VC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"

_DIAGNOSTICS_CACHE_TTL_S = 30.0
_NVIDIA_SMI_TIMEOUT_S = 2.0
_last_diagnostics: dict[str, Any] | None = None
_last_collected_at: float | None = None
_last_signature: tuple[str, str, str] | None = None
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
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=driver_version",
                "--format=csv,noheader",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=_NVIDIA_SMI_TIMEOUT_S,
        )
    except FileNotFoundError:
        return None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None

    output = completed.stdout.strip()
    return output or None


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


def _get_engine_device(settings: Settings) -> str:
    return settings.nemotron_device if settings.engine == "nemotron" else settings.whisper_device


def check_cuda_capability(device: str) -> CudaDiagnostics:
    capabilities = detect_gpu_capabilities(device)
    compute_capability: str | None = None

    if capabilities.cuda_available and capabilities.device_index is not None:
        try:
            import torch

            major, minor = torch.cuda.get_device_capability(capabilities.device_index)
            compute_capability = f"{major}.{minor}"
        except Exception:
            compute_capability = None

    return CudaDiagnostics(
        available=capabilities.cuda_available,
        device=capabilities.device,
        reason=capabilities.reason,
        name=capabilities.name,
        compute_capability=compute_capability,
    )


def check_ctranslate2_cuda_dlls() -> CudaDllDiagnostics:
    try:
        ctranslate2 = _load_ctranslate2()
    except Exception as exc:
        return CudaDllDiagnostics(available=False, detail=str(exc))

    try:
        if hasattr(ctranslate2, "get_cuda_device_count"):
            _ = ctranslate2.get_cuda_device_count()
        elif hasattr(ctranslate2, "get_supported_compute_types"):
            _ = ctranslate2.get_supported_compute_types("cuda")
        return CudaDllDiagnostics(available=True, detail=None)
    except OSError as exc:
        return CudaDllDiagnostics(available=False, detail=str(exc))
    except Exception as exc:
        return CudaDllDiagnostics(available=False, detail=str(exc))


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

    versions = [line.strip() for line in output.splitlines() if line.strip()]
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
                message="Microsoft Visual C++ Redistributable is required for Murmur to run.",
                action="Install the Visual C++ Redistributable (x64), then restart Murmur.",
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
                    message="CUDA runtime DLLs required for GPU acceleration are missing.",
                    action="Install or update the NVIDIA driver (525+), or switch to CPU mode in Settings > Server.",
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
                    action="Update your NVIDIA driver and restart Murmur.",
                    url=NVIDIA_DRIVER_URL,
                )
            )

    return warnings


def collect_diagnostics(settings: Settings, *, force: bool = False) -> dict[str, Any]:
    global _last_diagnostics, _last_collected_at, _last_signature

    signature = (settings.engine, settings.whisper_device, settings.nemotron_device)

    with _diagnostics_refresh_lock:
        now = time.time()
        if (
            not force
            and _last_diagnostics is not None
            and _last_collected_at is not None
            and _last_signature == signature
            and now - _last_collected_at < _DIAGNOSTICS_CACHE_TTL_S
        ):
            return _last_diagnostics

        device = _get_engine_device(settings)
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

        _last_diagnostics = serialized
        _last_collected_at = now
        _last_signature = signature

        return serialized
