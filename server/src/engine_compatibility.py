"""Bounded runtime capability checks for engine settings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ComputeCapability:
    """Supported compute types for one CTranslate2 device."""

    compute_types: frozenset[str] | None
    reason: str | None = None


@dataclass(frozen=True)
class RuntimeCapabilities:
    """Compatibility facts discovered without loading a model."""

    whisper_cpu: ComputeCapability
    whisper_cuda: ComputeCapability
    nemotron_cuda_available: bool
    nemotron_cuda_reason: str | None = None

    @property
    def whisper_cuda_available(self) -> bool:
        return bool(self.whisper_cuda.compute_types)

    def whisper_device_for(self, requested_device: str) -> str:
        if requested_device == "auto" and self.whisper_cuda_available:
            return "cuda"
        return "cpu" if requested_device == "auto" else requested_device


def _load_ctranslate2() -> Any:
    import ctranslate2

    return ctranslate2


def _load_torch() -> Any:
    import torch

    return torch


def _probe_compute_types(runtime: Any, device: str) -> ComputeCapability:
    try:
        compute_types = frozenset(runtime.get_supported_compute_types(device))
    except Exception:
        return ComputeCapability(
            None, "CTranslate2 capability check failed for this device."
        )
    if not compute_types:
        return ComputeCapability(
            None, "CTranslate2 reported no supported compute types for this device."
        )
    return ComputeCapability(compute_types)


def get_runtime_capabilities() -> RuntimeCapabilities:
    """Probe installed runtimes only; never load or download model data."""
    try:
        ctranslate2 = _load_ctranslate2()
    except Exception:
        whisper_cpu = ComputeCapability(None, "CTranslate2 runtime is unavailable.")
        whisper_cuda = ComputeCapability(None, "CTranslate2 runtime is unavailable.")
    else:
        whisper_cpu = _probe_compute_types(ctranslate2, "cpu")
        try:
            cuda_count = ctranslate2.get_cuda_device_count()
        except Exception:
            whisper_cuda = ComputeCapability(
                None, "CTranslate2 CUDA capability check failed."
            )
        else:
            if cuda_count < 1:
                whisper_cuda = ComputeCapability(
                    None, "CTranslate2 did not find a usable CUDA device."
                )
            else:
                whisper_cuda = _probe_compute_types(ctranslate2, "cuda")

    try:
        torch = _load_torch()
        nemotron_cuda_available = bool(torch.cuda.is_available())
    except Exception:
        nemotron_cuda_available = False
        nemotron_cuda_reason = "PyTorch CUDA support is unavailable."
    else:
        nemotron_cuda_reason = (
            None if nemotron_cuda_available else "PyTorch did not find a usable CUDA device."
        )

    return RuntimeCapabilities(
        whisper_cpu=whisper_cpu,
        whisper_cuda=whisper_cuda,
        nemotron_cuda_available=nemotron_cuda_available,
        nemotron_cuda_reason=nemotron_cuda_reason,
    )


def get_whisper_language_codes() -> frozenset[str] | None:
    """Return Faster-Whisper's installed language codes when available."""
    try:
        from faster_whisper.tokenizer import _LANGUAGE_CODES
    except Exception:
        return None
    return frozenset(_LANGUAGE_CODES)


def normalize_whisper_language(value: str | None) -> str | None:
    """Normalize a manual language code, preserving blank auto-detection."""
    if value is None:
        return None
    normalized = value.strip().lower()
    if not normalized:
        return None
    language_codes = get_whisper_language_codes()
    if language_codes is not None and normalized not in language_codes:
        raise ValueError("Unsupported Whisper language code.")
    return normalized


def validate_engine_compatibility(
    *,
    whisper_device: str,
    whisper_compute_type: str,
    nemotron_device: str,
    capabilities: RuntimeCapabilities,
) -> None:
    """Reject explicit settings that the currently installed runtimes cannot use."""
    if whisper_device == "cuda" and not capabilities.whisper_cuda_available:
        raise ValueError(capabilities.whisper_cuda.reason or "Whisper CUDA is unavailable.")

    if nemotron_device == "cuda" and not capabilities.nemotron_cuda_available:
        raise ValueError(capabilities.nemotron_cuda_reason or "Nemotron CUDA is unavailable.")

    if whisper_compute_type == "auto":
        return

    effective_device = capabilities.whisper_device_for(whisper_device)
    capability = (
        capabilities.whisper_cuda
        if effective_device == "cuda"
        else capabilities.whisper_cpu
    )
    if capability.compute_types is None:
        raise ValueError(capability.reason or "Whisper precision capability is unavailable.")
    if whisper_compute_type not in capability.compute_types:
        raise ValueError(
            f"Whisper precision {whisper_compute_type} is not supported on {effective_device}."
        )


def option_compatibility(
    key: str,
    value: str,
    capabilities: RuntimeCapabilities,
    settings: Any,
    *,
    whisper_device: str | None = None,
) -> tuple[bool, str | None]:
    """Return UI option state using the same facts as server-side validation."""
    if key == "whisper_device" and value == "cuda":
        return (
            not capabilities.whisper_cuda_available,
            capabilities.whisper_cuda.reason,
        )
    if key == "nemotron_device" and value == "cuda":
        return (
            not capabilities.nemotron_cuda_available,
            capabilities.nemotron_cuda_reason,
        )
    if key != "whisper_compute_type" or value == "auto":
        return False, None

    effective_device = capabilities.whisper_device_for(
        whisper_device or settings.whisper_device
    )
    capability = (
        capabilities.whisper_cuda
        if effective_device == "cuda"
        else capabilities.whisper_cpu
    )
    if capability.compute_types is None:
        return True, capability.reason
    if value not in capability.compute_types:
        return (
            True,
            f"Not supported by CTranslate2 on {effective_device}.",
        )
    return False, None
