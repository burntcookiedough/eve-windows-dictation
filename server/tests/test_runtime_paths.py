"""Optional Windows GPU runtime path validation and registration tests."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

import runtime_paths


pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows DLL search semantics")


@pytest.mark.parametrize(
    "directory_name", ["GPU runtime with spaces", "GPU runtime O'Brien"]
)
def test_explicit_gpu_runtime_directory_is_registered_and_precedes_path(
    directory_name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime_dir = tmp_path / directory_name
    runtime_dir.mkdir()
    prior_path = tmp_path / "other runtime"
    monkeypatch.setenv("PATH", os.pathsep.join([str(prior_path), str(runtime_dir)]))
    monkeypatch.setenv(runtime_paths.GPU_RUNTIME_DIR_ENV, str(runtime_dir))
    monkeypatch.setenv(runtime_paths.GPU_PACK_ID_ENV, "pack-sha256-1234")
    monkeypatch.setenv(runtime_paths.APP_BUILD_ID_ENV, "eve-build-2026.09")

    registrations: list[str] = []
    monkeypatch.setattr(
        runtime_paths.os,
        "add_dll_directory",
        lambda path: registrations.append(path) or object(),
    )

    configured = runtime_paths.configure_windows_cuda_dll_search(tmp_path)

    assert configured == runtime_dir.resolve()
    assert registrations == [str(runtime_dir.resolve())]
    path_entries = os.environ["PATH"].split(os.pathsep)
    assert Path(path_entries[0]) == runtime_dir.resolve()
    assert sum(
        os.path.normcase(os.path.normpath(entry))
        == os.path.normcase(os.path.normpath(str(runtime_dir)))
        for entry in path_entries
    ) == 1
    assert runtime_paths.registered_gpu_pack_id() == "pack-sha256-1234"
    assert runtime_paths.gpu_runtime_allowed() is True

    runtime_dir.rmdir()
    assert runtime_paths.registered_gpu_pack_id() is None
    assert runtime_paths.gpu_runtime_allowed() is False


@pytest.mark.parametrize("path_kind", ["empty", "relative", "missing", "file"])
def test_invalid_explicit_gpu_runtime_path_fails_closed(
    path_kind: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    if path_kind == "empty":
        runtime_path = ""
    elif path_kind == "relative":
        runtime_path = "gpu-runtime"
    elif path_kind == "missing":
        runtime_path = str(tmp_path / "missing gpu runtime")
    else:
        file_path = tmp_path / "not-a-directory"
        file_path.write_text("fixture", encoding="utf-8")
        runtime_path = str(file_path)

    monkeypatch.setenv(runtime_paths.GPU_RUNTIME_DIR_ENV, runtime_path)
    monkeypatch.setenv(runtime_paths.GPU_PACK_ID_ENV, "untrusted-pack-id")
    registrations: list[str] = []
    monkeypatch.setattr(
        runtime_paths.os,
        "add_dll_directory",
        lambda path: registrations.append(path) or object(),
    )

    with pytest.raises(RuntimeError, match="MURMUR_GPU_RUNTIME_DIR"):
        runtime_paths.configure_windows_cuda_dll_search(tmp_path)

    assert registrations == []
    assert runtime_paths.registered_gpu_pack_id() is None


def test_pack_id_is_not_reported_without_an_explicit_registered_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(runtime_paths.GPU_RUNTIME_DIR_ENV, raising=False)
    monkeypatch.setenv(runtime_paths.GPU_PACK_ID_ENV, "stale-pack-id")
    monkeypatch.setattr(runtime_paths, "packaged_torch_lib", lambda _root: tmp_path / "missing")

    assert runtime_paths.configure_windows_cuda_dll_search(tmp_path) is None
    assert runtime_paths.registered_gpu_pack_id() is None


def test_packaged_cpu_launch_does_not_use_system_cuda_without_a_pack(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(runtime_paths.GPU_RUNTIME_DIR_ENV, raising=False)
    monkeypatch.delenv(runtime_paths.GPU_PACK_ID_ENV, raising=False)
    monkeypatch.setenv(runtime_paths.APP_BUILD_ID_ENV, "eve-build-2026.09")
    monkeypatch.setattr(runtime_paths, "packaged_torch_lib", lambda _root: tmp_path / "missing")

    assert runtime_paths.configure_windows_cuda_dll_search(tmp_path) is None
    assert runtime_paths.gpu_runtime_allowed() is False


def test_development_launch_keeps_existing_cuda_discovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(runtime_paths.GPU_RUNTIME_DIR_ENV, raising=False)
    monkeypatch.delenv(runtime_paths.GPU_PACK_ID_ENV, raising=False)
    monkeypatch.delenv(runtime_paths.APP_BUILD_ID_ENV, raising=False)
    monkeypatch.setattr(runtime_paths, "packaged_torch_lib", lambda _root: tmp_path / "missing")

    assert runtime_paths.configure_windows_cuda_dll_search(tmp_path) is None
    assert runtime_paths.gpu_runtime_allowed() is True
