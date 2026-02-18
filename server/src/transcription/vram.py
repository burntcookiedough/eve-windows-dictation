"""GPU VRAM capability detection and recording duration estimation."""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Empirical starting constants from docs/vram-aware-engine-selection.md
NEMOTRON_BASE_VRAM_GB = 5.0
NEMOTRON_GROWTH_MB_PER_SEC = 100.0
NEMOTRON_MIN_VRAM_GB = 8.0

WHISPER_BASE_VRAM_GB = 3.1
WHISPER_GROWTH_MB_PER_SEC = 57.0

_GB_BYTES = 1024**3
_MB_PER_GB = 1024.0


@dataclass(frozen=True, slots=True)
class EngineVramProfile:
    engine_id: str
    base_vram_gb: float
    growth_mb_per_sec: float
    min_recommended_vram_gb: float | None = None


ENGINE_VRAM_PROFILES: dict[str, EngineVramProfile] = {
    "nemotron": EngineVramProfile(
        engine_id="nemotron",
        base_vram_gb=NEMOTRON_BASE_VRAM_GB,
        growth_mb_per_sec=NEMOTRON_GROWTH_MB_PER_SEC,
        min_recommended_vram_gb=NEMOTRON_MIN_VRAM_GB,
    ),
    "whisper": EngineVramProfile(
        engine_id="whisper",
        base_vram_gb=WHISPER_BASE_VRAM_GB,
        growth_mb_per_sec=WHISPER_GROWTH_MB_PER_SEC,
        min_recommended_vram_gb=None,
    ),
}


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
        return int(suffix)

    raise ValueError(f"Unsupported CUDA device selector: {device!r}")


def detect_gpu_capabilities(device: str) -> GpuCapabilities:
    """Detect CUDA device name and total VRAM for the selected device.

    This uses total VRAM (not current free VRAM) as a stable startup signal.
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

    try:
        import torch
    except ImportError:
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason="PyTorch is not installed",
        )

    if not torch.cuda.is_available():
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason="CUDA is not available",
        )

    try:
        device_index = _resolve_cuda_device_index(device)
    except ValueError as error:
        logger.warning("Failed to resolve CUDA device selector", exc_info=error)
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason=str(error),
        )

    try:
        props = torch.cuda.get_device_properties(device_index)
    except Exception as error:  # pragma: no cover - depends on local CUDA runtime
        logger.warning("Failed to query CUDA device properties", exc_info=error)
        return GpuCapabilities(
            cuda_available=False,
            device=device,
            device_index=None,
            name=None,
            total_vram_gb=None,
            reason=f"Failed to query CUDA device: {error}",
        )

    total_vram_gb = props.total_memory / _GB_BYTES
    return GpuCapabilities(
        cuda_available=True,
        device=device,
        device_index=device_index,
        name=props.name,
        total_vram_gb=total_vram_gb,
        reason=None,
    )


def estimate_max_duration_s(engine_id: str, total_vram_gb: float | None) -> int | None:
    """Estimate max single-recording duration from total VRAM.

    Returns None when an estimate cannot be produced.
    """
    profile = ENGINE_VRAM_PROFILES.get(engine_id)
    if profile is None or total_vram_gb is None:
        return None

    growth_budget_gb = total_vram_gb - profile.base_vram_gb
    if growth_budget_gb <= 0:
        return 0

    growth_budget_mb = growth_budget_gb * _MB_PER_GB
    duration_s = int(growth_budget_mb / profile.growth_mb_per_sec)
    return max(0, duration_s)


def get_vram_profile(engine_id: str) -> EngineVramProfile | None:
    return ENGINE_VRAM_PROFILES.get(engine_id)
