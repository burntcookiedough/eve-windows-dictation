"""Runtime checks used before activating a Nemotron CUDA engine."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from runtime_paths import packaged_torch_lib
from transcription.errors import NemotronCudaPreflightError


def _runtime_detail(torch_module: Any, cuda_lib_dir: Path) -> str:
    torch_version = getattr(torch_module, "__version__", "unknown")
    version_info = getattr(torch_module, "version", None)
    cuda_version = getattr(version_info, "cuda", "unknown")
    cudnn_version = "unknown"
    try:
        cudnn_version = str(torch_module.backends.cudnn.version())
    except Exception:
        pass
    return (
        f"torch={torch_version}; torch_cuda={cuda_version}; "
        f"cudnn={cudnn_version}; torch_lib={cuda_lib_dir}"
    )


def preflight_nemotron_cuda(
    torch_module: Any,
    *,
    cuda_lib_dir: Path | None = None,
) -> None:
    """Run a bounded real CUDA/cuDNN operation before candidate activation.

    ``torch.cuda.is_available()`` only reports device discovery.  A small
    convolution exercises the same CUDA/cuDNN loading path that Nemotron
    depends on, including Windows DLL entry-point resolution.
    """
    lib_dir = cuda_lib_dir or packaged_torch_lib()
    tensors: list[Any] = []
    try:
        if not bool(torch_module.cuda.is_available()):
            raise NemotronCudaPreflightError(
                "CUDA preflight unavailable: torch.cuda.is_available() is false."
            )

        torch_module.cuda.init()
        cudnn = torch_module.backends.cudnn
        if (
            not bool(cudnn.is_available())
            or not bool(getattr(cudnn, "enabled", True))
            or cudnn.version() is None
        ):
            raise NemotronCudaPreflightError(
                f"CUDA preflight unavailable: cuDNN is not usable ({_runtime_detail(torch_module, lib_dir)})."
            )

        tensors.extend(
            [
                torch_module.zeros((1, 1, 8), device="cuda", dtype=torch_module.float32),
                torch_module.ones((1, 1, 3), device="cuda", dtype=torch_module.float32),
            ]
        )
        with torch_module.no_grad():
            torch_module.nn.functional.conv1d(tensors[0], tensors[1])
        torch_module.cuda.synchronize()
    except NemotronCudaPreflightError:
        raise
    except Exception as exc:
        raise NemotronCudaPreflightError(
            "CUDA preflight failed while executing a cuDNN convolution "
            f"({_runtime_detail(torch_module, lib_dir)}): {exc}"
        ) from exc
    finally:
        tensors.clear()
        try:
            torch_module.cuda.empty_cache()
        except Exception:
            pass
