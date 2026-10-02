"""GPU VRAM capability detection and recording duration estimation."""

from __future__ import annotations

import csv
import io
import logging
import subprocess
import threading
import time
from dataclasses import dataclass

from runtime_paths import gpu_runtime_allowed

logger = logging.getLogger(__name__)

# Empirical starting constants from the historical VRAM measurements.
WHISPER_BASE_VRAM_GB = 3.1
WHISPER_GROWTH_MB_PER_SEC = 57.0

_MB_PER_GB = 1024.0
_NVIDIA_SMI_TIMEOUT_S = 2.0
_NVIDIA_SMI_CACHE_TTL_S = 30.0
_nvidia_smi_cache_lock = threading.Lock()
_nvidia_smi_cached_at: float | None = None
_nvidia_smi_cached_output: str | None = None


@dataclass(frozen=True, slots=True)
class VramProfile:
    base_vram_gb: float
    growth_mb_per_sec: float


WHISPER_VRAM_PROFILE = VramProfile(
    base_vram_gb=WHISPER_BASE_VRAM_GB,
    growth_mb_per_sec=WHISPER_GROWTH_MB_PER_SEC,
)


@dataclass(frozen=True, slots=True)
class GpuCapabilities:
    cuda_available: bool
    device: str
    device_index: int | None
    name: str | None
    total_vram_gb: float | None
    reason: str | None = None


def _resolve_cuda_device_index(device: str) -> int:
    if device in {"auto", "cuda"}:
        return 0

    if device.startswith("cuda:"):
        _, _, suffix = device.partition(":")
        try:
            device_index = int(suffix)
        except ValueError as error:
            raise ValueError(f"Unsupported CUDA device selector: {device!r}") from error
        if device_index < 0:
            raise ValueError(f"Unsupported CUDA device selector: {device!r}")
        return device_index

    raise ValueError(f"Unsupported CUDA device selector: {device!r}")


def _get_nvidia_smi_output() -> str | None:
    """Return cached driver and GPU metadata from one bounded system query."""
    global _nvidia_smi_cached_at, _nvidia_smi_cached_output

    with _nvidia_smi_cache_lock:
        now = time.monotonic()
        if (
            _nvidia_smi_cached_at is not None
            and now - _nvidia_smi_cached_at < _NVIDIA_SMI_CACHE_TTL_S
        ):
            return _nvidia_smi_cached_output

        try:
            completed = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=index,driver_version,name,memory.total",
                    "--format=csv,noheader,nounits",
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=_NVIDIA_SMI_TIMEOUT_S,
            )
        except (FileNotFoundError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            output = None
        else:
            output = completed.stdout.strip() or None

        _nvidia_smi_cached_at = now
        _nvidia_smi_cached_output = output
        return output


def _query_nvidia_device(device_index: int) -> tuple[str | None, float | None]:
    """Read optional display metadata without using a deep-learning framework."""
    output = _get_nvidia_smi_output()
    if output is None:
        return None, None

    for row in csv.reader(io.StringIO(output)):
        if len(row) < 4:
            continue
        try:
            row_index = int(row[0].strip())
            total_memory_mb = float(row[3].strip())
        except ValueError:
            continue
        if row_index == device_index and total_memory_mb >= 0:
            name = row[2].strip() or None
            return name, total_memory_mb / _MB_PER_GB
    return None, None


def detect_gpu_capabilities(device: str) -> GpuCapabilities:
    """Check CTranslate2 CUDA support and optionally read GPU display metadata.

    ``cuda_available`` means CTranslate2 found the selected device and reported
    supported CUDA compute types. It is a runtime capability probe, not proof
    that Whisper model loading or transcription succeeds. Total VRAM is a stable
    startup signal; it does not reflect currently free VRAM.
    """
    if device == "cpu":
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason="CPU device selected",
        )

    if not gpu_runtime_allowed():
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason="The optional GPU runtime is not installed.",
        )

    try:
        device_index = _resolve_cuda_device_index(device)
    except ValueError as error:
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason=str(error),
        )

    try:
        import ctranslate2
    except Exception:
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason="CTranslate2 runtime is unavailable",
        )

    try:
        device_count = ctranslate2.get_cuda_device_count()
    except Exception:
        logger.warning("CTranslate2 CUDA device query failed")
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason="CTranslate2 CUDA device query failed",
        )
    if device_index >= device_count:
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason="CTranslate2 did not find the selected CUDA device",
        )

    try:
        compute_types = ctranslate2.get_supported_compute_types("cuda", device_index)
    except Exception:
        logger.warning("CTranslate2 CUDA compute-type query failed")
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=device_index,
            name=None,
            total_vram_gb=None,
            reason="CTranslate2 CUDA compute-type query failed",
        )
    if not compute_types:
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=device_index,
            name=None,
            total_vram_gb=None,
            reason="CTranslate2 reports no supported CUDA compute types",
        )

    name, total_vram_gb = _query_nvidia_device(device_index)
    return GpuCapabilities(
        cuda_available=True,
        device=device,
        device_index=device_index,
        name=name,
        total_vram_gb=total_vram_gb,
        reason=None,
    )


def estimate_max_duration_s(total_vram_gb: float | None) -> int | None:
    """Estimate max single-recording duration from total VRAM.

    Returns None when an estimate cannot be produced.
    """
    if total_vram_gb is None:
        return None

    growth_budget_gb = total_vram_gb - WHISPER_VRAM_PROFILE.base_vram_gb
    if growth_budget_gb <= 0:
        return 0

    growth_budget_mb = growth_budget_gb * _MB_PER_GB
    duration_s = int(growth_budget_mb / WHISPER_VRAM_PROFILE.growth_mb_per_sec)
    return max(0, duration_s)
