"""Tests for Nemotron's runtime DLL path and real CUDA preflight boundary."""

from __future__ import annotations

import inspect
from pathlib import Path
from types import SimpleNamespace

import pytest

import runtime_paths
from transcription.errors import NemotronCudaPreflightError
from transcription.engines.nemotron import NemotronEngine
from transcription.nemotron_runtime import preflight_nemotron_cuda


class _FakeTensor:
    pass


class _FakeCuda:
    def __init__(self) -> None:
        self.initialized = False
        self.synchronized = False
        self.empty_cache_calls = 0

    def is_available(self) -> bool:
        return True

    def init(self) -> None:
        self.initialized = True

    def synchronize(self) -> None:
        self.synchronized = True

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1


class _FakeCudnn:
    enabled = True

    def is_available(self) -> bool:
        return True

    def version(self) -> int:
        return 9100


class _FakeTorch:
    __version__ = "2.6.0+cu124"
    float32 = object()

    def __init__(self, *, fail_conv: bool = False) -> None:
        self.cuda = _FakeCuda()
        self.backends = SimpleNamespace(cudnn=_FakeCudnn())
        self.version = SimpleNamespace(cuda="12.4")
        self.fail_conv = fail_conv
        self.conv_calls = 0
        self.nn = SimpleNamespace(
            functional=SimpleNamespace(conv1d=self._conv1d),
        )

    def zeros(self, *args, **kwargs) -> _FakeTensor:
        return _FakeTensor()

    def ones(self, *args, **kwargs) -> _FakeTensor:
        return _FakeTensor()

    def no_grad(self):
        class _NoGrad:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

        return _NoGrad()

    def _conv1d(self, *_args, **_kwargs) -> _FakeTensor:
        self.conv_calls += 1
        if self.fail_conv:
            raise OSError("cudnnGetLibConfig procedure not found")
        return _FakeTensor()


def test_cuda_preflight_executes_a_real_operation_and_cleans_up(tmp_path: Path) -> None:
    torch_module = _FakeTorch()

    preflight_nemotron_cuda(torch_module, cuda_lib_dir=tmp_path)

    assert torch_module.cuda.initialized is True
    assert torch_module.cuda.synchronized is True
    assert torch_module.cuda.empty_cache_calls == 1
    assert torch_module.conv_calls == 1


def test_cuda_preflight_converts_native_failure_to_recoverable_error(tmp_path: Path) -> None:
    with pytest.raises(NemotronCudaPreflightError, match="cudnnGetLibConfig") as error:
        preflight_nemotron_cuda(_FakeTorch(fail_conv=True), cuda_lib_dir=tmp_path)
    assert "torch=2.6.0+cu124" in str(error.value)
    assert "torch_cuda=12.4" in str(error.value)


def test_nemotron_preflight_precedes_model_download() -> None:
    source = inspect.getsource(NemotronEngine.__init__)

    assert source.index("resolved_device = device") < source.index("preflight_nemotron_cuda")
    assert source.index("preflight_nemotron_cuda") < source.index("begin_model_download_progress")
    assert source.index("preflight_nemotron_cuda") < source.index("ASRModel.from_pretrained")


def test_packaged_cuda_directory_is_registered_and_first_in_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    torch_lib = tmp_path / ".venv" / "Lib" / "site-packages" / "torch" / "lib"
    torch_lib.mkdir(parents=True)
    handles: list[str] = []

    monkeypatch.setattr(runtime_paths.sys, "platform", "win32")
    monkeypatch.setenv(
        "PATH",
        runtime_paths.os.pathsep.join(
            [r"C:\Windows\System32", str(torch_lib), r"C:\Windows\Other"]
        ),
    )
    monkeypatch.setattr(
        runtime_paths.os,
        "add_dll_directory",
        lambda path: handles.append(path) or object(),
        raising=False,
    )
    monkeypatch.setattr(runtime_paths, "_REGISTERED_DLL_DIRS", set())
    monkeypatch.setattr(runtime_paths, "_DLL_DIRECTORY_HANDLES", [])

    assert runtime_paths.configure_windows_cuda_dll_search(tmp_path) == torch_lib
    assert runtime_paths.configure_windows_cuda_dll_search(tmp_path) == torch_lib
    assert handles == [str(torch_lib)]
    path_entries = runtime_paths.os.environ["PATH"].split(runtime_paths.os.pathsep)
    assert path_entries[0] == str(torch_lib)
    assert path_entries.count(str(torch_lib)) == 1
