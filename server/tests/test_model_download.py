"""Model download cache detection and API payload tests."""

from __future__ import annotations

import asyncio
import importlib

from config import Settings
import app as app_module
from fastapi import FastAPI
from transcription import model_download


class _DummyEngineStatus:
    current = "whisper"
    status = "ready"
    info = None
    pending = None
    message = None


class _DummyEngineManager:
    def get_status(self) -> _DummyEngineStatus:
        return _DummyEngineStatus()


class _DummySessionManager:
    active_count = 0
    max_sessions = 1


def _get_route_endpoint(app: FastAPI, path: str, method: str):
    for route in app.routes:
        if getattr(route, "path", None) == path and method in route.methods:
            return route.endpoint
    raise AssertionError(f"Route {method} {path} not found")


def _write_required_snapshot(snapshot_dir) -> None:
    snapshot_dir.mkdir(parents=True)
    for name in [
        "config.json",
        "model.bin",
        "preprocessor_config.json",
        "tokenizer.json",
        "vocabulary.json",
    ]:
        (snapshot_dir / name).write_text("x", encoding="utf-8")


def test_is_repo_cached_rejects_empty_snapshot(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))

    snapshot_dir = (
        cache_dir
        / "models--Systran--faster-whisper-large-v3-turbo"
        / "snapshots"
        / "abc123"
    )
    snapshot_dir.mkdir(parents=True)

    status = model_download.get_repo_cache_status("Systran/faster-whisper-large-v3-turbo")
    assert status.status == "partial"
    assert model_download.is_repo_cached("Systran/faster-whisper-large-v3-turbo") is False


def test_is_repo_cached_detects_complete_snapshot(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))

    snapshot_dir = (
        cache_dir
        / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo"
        / "snapshots"
        / "abc123"
    )
    _write_required_snapshot(snapshot_dir)

    status = model_download.get_repo_cache_status(
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    )
    assert status.status == "ready"
    assert status.cached is True
    assert model_download.is_repo_cached(
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    ) is True


def test_is_repo_cached_rejects_incomplete_files(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))

    repo_dir = cache_dir / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo"
    snapshot_dir = repo_dir / "snapshots" / "abc123"
    _write_required_snapshot(snapshot_dir)
    (repo_dir / "blobs").mkdir()
    (repo_dir / "blobs" / "abc.incomplete").write_text("partial", encoding="utf-8")

    status = model_download.get_repo_cache_status(
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    )
    assert status.status == "downloading"
    assert status.partial_files
    assert model_download.is_repo_cached(
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    ) is False


def test_is_repo_cached_returns_false_without_snapshot(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))

    status = model_download.get_repo_cache_status("Systran/faster-whisper-large-v3-turbo")
    assert status.status == "missing"
    assert model_download.is_repo_cached("Systran/faster-whisper-large-v3-turbo") is False


def test_cached_required_bytes_preserves_resume_baseline(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
    snapshot_dir = (
        cache_dir
        / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo"
        / "snapshots"
        / "abc123"
    )
    _write_required_snapshot(snapshot_dir)
    (snapshot_dir / "vocabulary.json").unlink()

    cached_bytes = model_download.get_cached_required_bytes(
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    )
    assert cached_bytes == 4

    model_download.begin_model_download_progress(
        model="tiny",
        repo_id="example/tiny",
        size_gb=100 / 1024**3,
        initial_bytes=cached_bytes,
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=100 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    assert model_download.get_model_download_state()["downloaded_bytes"] == 4


def test_health_includes_model_download(monkeypatch) -> None:
    monkeypatch.setattr(app_module, "get_session_manager", lambda: _DummySessionManager())
    monkeypatch.setattr(app_module, "get_engine_manager", lambda: _DummyEngineManager())
    monkeypatch.setattr(app_module, "get_settings", lambda: Settings())
    monkeypatch.setattr(app_module, "collect_diagnostics", lambda settings: {"warnings": []})

    model_download.update_model_download_state(
        model="large-v3-turbo",
        size_gb=1.5,
        status="downloading",
        cached=False,
        detail="download started",
    )

    app = app_module.create_app()
    endpoint = _get_route_endpoint(app, "/health", "GET")
    payload = asyncio.run(endpoint())

    assert payload["model_download"]["status"] == "downloading"
    assert payload["model_download"]["model"] == "large-v3-turbo"


def test_byte_progress_reports_percentage_speed_and_eta(monkeypatch) -> None:
    clock = [0.0]
    monkeypatch.setattr(model_download.time, "monotonic", lambda: clock[0])

    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=100 / 1024**3
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=100 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(
        1,
        total=100,
        description="model.bin",
    )
    clock[0] = 10.0
    model_download.report_model_download_bytes(1, 50)

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["progress_percent"] == 50.0
    assert state["downloaded_bytes"] == 50
    assert state["total_bytes"] == 100
    assert state["bytes_per_second"] == 5
    assert state["eta_seconds"] is None  # Very low rates do not produce noisy ETAs.
    assert state["current_file"] == "model weights"


def test_byte_progress_uses_recent_rate_for_eta(monkeypatch) -> None:
    clock = [0.0]
    monkeypatch.setattr(model_download.time, "monotonic", lambda: clock[0])

    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=10_000_000 / 1024**3
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=10_000_000 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(2, total=10_000_000)
    clock[0] = 5.0
    model_download.report_model_download_bytes(2, 5_000_000)

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["bytes_per_second"] == 1_000_000
    assert state["eta_seconds"] == 5


def test_byte_progress_hides_eta_after_stall(monkeypatch) -> None:
    clock = [0.0]
    monkeypatch.setattr(model_download.time, "monotonic", lambda: clock[0])

    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=10_000_000 / 1024**3
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=10_000_000 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(4, total=10_000_000)
    clock[0] = 5.0
    model_download.report_model_download_bytes(4, 5_000_000)
    clock[0] = 21.0

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["bytes_per_second"] is None
    assert state["eta_seconds"] is None


def test_resumed_bytes_do_not_inflate_transfer_rate(monkeypatch) -> None:
    clock = [0.0]
    monkeypatch.setattr(model_download.time, "monotonic", lambda: clock[0])
    model_download.begin_model_download_progress(
        model="tiny",
        repo_id="example/tiny",
        size_gb=10_000_000 / 1024**3,
        initial_bytes=4_000_000,
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=10_000_000 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(5, total=6_000_000, initial=1_000_000)
    clock[0] = 5.0
    model_download.report_model_download_bytes(5, 1_000_000)

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == 6_000_000
    assert state["bytes_per_second"] == 200_000
    assert state["eta_seconds"] == 20


def test_other_engines_do_not_inherit_whisper_progress(monkeypatch) -> None:
    monkeypatch.setattr(model_download.time, "monotonic", lambda: 1.0)
    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=100 / 1024**3
    )
    model_download.register_model_download_transfer(6, total=100)
    model_download.report_model_download_bytes(6, 50)
    model_download.update_model_download_state(
        model="nemotron",
        size_gb=2.3,
        status="downloading",
        phase="downloading",
        repo_id="nvidia/nemotron",
    )

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["progress_percent"] is None
    assert state["downloaded_bytes"] is None
    assert state["eta_seconds"] is None


def test_mark_model_loading_clears_network_eta(monkeypatch) -> None:
    monkeypatch.setattr(model_download.time, "monotonic", lambda: 1.0)
    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=100 / 1024**3
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=100 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(3, total=100)
    model_download.report_model_download_bytes(3, 100)

    model_download.mark_model_loading()
    state = model_download.get_model_download_state()
    assert state is not None
    assert state["status"] == "downloading"
    assert state["phase"] == "loading"
    assert state["progress_percent"] == 100.0
    assert state["eta_seconds"] is None


def test_huggingface_progress_bridge_observes_byte_callbacks(monkeypatch) -> None:
    clock = [0.0]
    monkeypatch.setattr(model_download.time, "monotonic", lambda: clock[0])
    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=100 / 1024**3
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=100 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )

    tqdm_module = importlib.import_module("huggingface_hub.utils.tqdm")
    with model_download.track_huggingface_download_progress():
        with tqdm_module.tqdm(
            desc="model.bin",
            total=100,
            initial=0,
            disable=True,
        ) as progress:
            clock[0] = 2.0
            progress.update(25)

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == 25
    assert state["progress_percent"] == 25.0


def test_huggingface_progress_bridge_restores_nested_and_failed_contexts() -> None:
    tqdm_module = importlib.import_module("huggingface_hub.utils.tqdm")
    original_tqdm = tqdm_module.tqdm

    with model_download.track_huggingface_download_progress():
        reporting_tqdm = tqdm_module.tqdm
        assert reporting_tqdm is not original_tqdm
        with model_download.track_huggingface_download_progress():
            assert tqdm_module.tqdm is reporting_tqdm
        assert tqdm_module.tqdm is reporting_tqdm
    assert tqdm_module.tqdm is original_tqdm

    try:
        with model_download.track_huggingface_download_progress():
            raise RuntimeError("test failure")
    except RuntimeError:
        pass
    assert tqdm_module.tqdm is original_tqdm
