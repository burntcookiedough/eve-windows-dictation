"""Deterministic paths for the self-contained Windows server runtime."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import threading
from typing import Any


GPU_RUNTIME_DIR_ENV = "MURMUR_GPU_RUNTIME_DIR"
GPU_PACK_ID_ENV = "MURMUR_GPU_PACK_ID"
APP_BUILD_ID_ENV = "MURMUR_APP_BUILD_ID"

_REGISTERED_DLL_DIRS: set[str] = set()
_DLL_DIRECTORY_HANDLES: list[Any] = []
_REGISTRATION_LOCK = threading.Lock()
_ACTIVE_GPU_RUNTIME_DIR: Path | None = None
_ACTIVE_GPU_PACK_ID: str | None = None


def packaged_torch_lib(server_dir: Path | None = None) -> Path:
    """Return the development PyTorch DLL directory when one is installed."""
    root = server_dir or Path(__file__).resolve().parent.parent
    return root / ".venv" / "Lib" / "site-packages" / "torch" / "lib"


def _normalized_directory(path: Path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def _validated_gpu_runtime_dir(raw_path: str) -> Path:
    """Resolve an explicit GPU runtime path or fail closed with a safe error."""
    if not raw_path or raw_path != raw_path.strip() or any(
        character in raw_path for character in ('"', "'", "\x00", "\r", "\n")
    ):
        raise RuntimeError(
            "MURMUR_GPU_RUNTIME_DIR must name an absolute existing directory."
        )

    try:
        candidate = Path(raw_path)
        if not candidate.is_absolute():
            raise ValueError("GPU runtime directory must be absolute")
        resolved = candidate.resolve(strict=True)
        if not resolved.is_dir():
            raise ValueError("GPU runtime path is not a directory")
    except (OSError, RuntimeError, ValueError):
        # Do not put a local profile or managed pack path into logs.
        raise RuntimeError(
            "MURMUR_GPU_RUNTIME_DIR must name an absolute existing directory."
        ) from None
    return resolved


def _safe_pack_id(value: str | None) -> str | None:
    if (
        value is None
        or not value
        or len(value) > 128
        or value != value.strip()
        or any(ord(character) < 32 for character in value)
    ):
        return None
    return value


def _register_windows_dll_directory(directory: Path, *, required: bool) -> None:
    normalized = _normalized_directory(directory)
    add_dll_directory = getattr(os, "add_dll_directory", None)

    if required and not callable(add_dll_directory):
        raise RuntimeError("This Python runtime cannot register GPU DLL directories.")

    with _REGISTRATION_LOCK:
        if normalized not in _REGISTERED_DLL_DIRS:
            if callable(add_dll_directory):
                try:
                    _DLL_DIRECTORY_HANDLES.append(add_dll_directory(str(directory)))
                except (OSError, ValueError):
                    if required:
                        raise RuntimeError(
                            "Could not register the GPU runtime directory."
                        ) from None
                    raise
            _REGISTERED_DLL_DIRS.add(normalized)

        path_entries = [
            entry
            for entry in os.environ.get("PATH", "").split(os.pathsep)
            if entry and os.path.normcase(os.path.normpath(entry)) != normalized
        ]
        os.environ["PATH"] = os.pathsep.join([str(directory), *path_entries])


def configure_windows_cuda_dll_search(
    server_dir: Path | None = None,
) -> Path | None:
    """Register the selected CUDA DLL directory before native imports.

    The Electron main process passes ``MURMUR_GPU_RUNTIME_DIR`` only after it
    validates an installed optional pack. The server still verifies that the
    value is absolute and names an existing directory. Invalid explicit values
    fail startup instead of falling back to an unrelated DLL directory.

    A checkout with no explicit pack keeps the historical development-only
    ``torch/lib`` lookup. The CPU release runtime has no Torch package, so this
    compatibility lookup is simply absent there.
    """
    global _ACTIVE_GPU_RUNTIME_DIR, _ACTIVE_GPU_PACK_ID

    raw_gpu_runtime_dir = os.environ.get(GPU_RUNTIME_DIR_ENV)
    with _REGISTRATION_LOCK:
        _ACTIVE_GPU_RUNTIME_DIR = None
        _ACTIVE_GPU_PACK_ID = None

    if raw_gpu_runtime_dir is not None:
        if sys.platform != "win32":
            raise RuntimeError("The optional GPU runtime is supported only on Windows.")

        gpu_runtime_dir = _validated_gpu_runtime_dir(raw_gpu_runtime_dir)
        _register_windows_dll_directory(gpu_runtime_dir, required=True)
        with _REGISTRATION_LOCK:
            _ACTIVE_GPU_RUNTIME_DIR = gpu_runtime_dir
            _ACTIVE_GPU_PACK_ID = _safe_pack_id(os.environ.get(GPU_PACK_ID_ENV))
        return gpu_runtime_dir

    if sys.platform != "win32":
        return None

    torch_lib = packaged_torch_lib(server_dir)
    if not torch_lib.is_dir():
        return None

    _register_windows_dll_directory(torch_lib, required=False)
    return torch_lib


def registered_gpu_pack_id() -> str | None:
    """Return the managed pack ID only after its directory was registered."""
    with _REGISTRATION_LOCK:
        runtime_dir = _ACTIVE_GPU_RUNTIME_DIR
        pack_id = _ACTIVE_GPU_PACK_ID
    if runtime_dir is None or not runtime_dir.is_dir():
        return None
    return pack_id


def gpu_runtime_allowed() -> bool:
    """Gate CUDA capability discovery in packaged builds on the optional pack.

    Development and legacy launches have no main-process build marker, so
    their existing system or development CUDA behavior remains available.
    Packaged CPU builds carry ``MURMUR_APP_BUILD_ID`` and must have explicitly
    registered an existing validated runtime directory before CUDA can be
    selected. This prevents a system-wide CUDA Toolkit from changing CPU
    startup behavior.
    """
    if APP_BUILD_ID_ENV not in os.environ:
        return True

    with _REGISTRATION_LOCK:
        runtime_dir = _ACTIVE_GPU_RUNTIME_DIR
    return runtime_dir is not None and runtime_dir.is_dir()
