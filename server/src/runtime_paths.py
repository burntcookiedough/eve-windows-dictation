"""Deterministic paths for the self-contained Windows server runtime."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import threading
from typing import Any


_REGISTERED_DLL_DIRS: set[str] = set()
_DLL_DIRECTORY_HANDLES: list[Any] = []
_REGISTRATION_LOCK = threading.Lock()


def packaged_torch_lib(server_dir: Path | None = None) -> Path:
    """Return the bundled PyTorch DLL directory for a server checkout/runtime."""
    root = server_dir or Path(__file__).resolve().parent.parent
    return root / ".venv" / "Lib" / "site-packages" / "torch" / "lib"


def configure_windows_cuda_dll_search(
    server_dir: Path | None = None,
) -> Path | None:
    """Prepend Eve's bundled CUDA DLL directory and keep it registered.

    The packaged PyTorch cu124 wheel owns the compatible CUDA/cuDNN DLL set.
    Registering and prepending that exact directory before optional engines
    import native code prevents an unrelated system DLL from winning search.
    Development environments without a bundled ``torch/lib`` are unchanged.
    """
    if sys.platform != "win32":
        return None

    torch_lib = packaged_torch_lib(server_dir)
    if not torch_lib.is_dir():
        return None

    normalized = os.path.normcase(os.path.normpath(str(torch_lib)))
    with _REGISTRATION_LOCK:
        if normalized not in _REGISTERED_DLL_DIRS:
            add_dll_directory = getattr(os, "add_dll_directory", None)
            if add_dll_directory is not None:
                _DLL_DIRECTORY_HANDLES.append(add_dll_directory(str(torch_lib)))
            _REGISTERED_DLL_DIRS.add(normalized)

        path_entries = [
            entry
            for entry in os.environ.get("PATH", "").split(os.pathsep)
            if entry and os.path.normcase(os.path.normpath(entry)) != normalized
        ]
        os.environ["PATH"] = os.pathsep.join([str(torch_lib), *path_entries])

    return torch_lib
