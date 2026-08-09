"""Model download cache detection and API payload tests."""

from __future__ import annotations

import asyncio
import importlib
from types import SimpleNamespace

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


def test_download_disk_preflight_uses_custom_hf_cache_and_selected_partial_bytes(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "custom-hf-cache"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
    repo_dir = cache_dir / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo"
    snapshot = repo_dir / "snapshots" / "partial"
    snapshot.mkdir(parents=True)
    (snapshot / "config.json").write_bytes(b"x" * 100)
    monkeypatch.setattr(model_download.shutil, "disk_usage", lambda path: SimpleNamespace(free=3 * 1024**3))

    result = model_download.check_download_disk_space("mobiuslabsgmbh/faster-whisper-large-v3-turbo", 1.5)

    assert result.inspected_path == str(cache_dir)
    assert result.remaining_estimated_bytes < int(1.5 * 1024**3)
    assert result.cushion_bytes == 512 * 1024**2


def test_download_disk_preflight_rejects_insufficient_space_without_cache_mutation(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
    monkeypatch.setattr(model_download.shutil, "disk_usage", lambda path: SimpleNamespace(free=1))

    try:
        model_download.check_download_disk_space("nvidia/nemotron-speech-streaming-en-0.6b", 2.3)
    except model_download.DownloadDiskPreflightError as exc:
        assert "Not enough free space" in str(exc)
    else:
        raise AssertionError("expected disk preflight failure")
    assert not cache_dir.exists()


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


def test_nemotron_cache_requires_its_downloaded_nemo_artifact(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
    snapshot_dir = (
        cache_dir
        / "models--nvidia--nemotron-speech-streaming-en-0.6b"
        / "snapshots"
        / "abc123"
    )
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / "config.json").write_text("{}", encoding="utf-8")

    status = model_download.get_repo_cache_status(
        "nvidia/nemotron-speech-streaming-en-0.6b"
    )
    assert status.cached is False
    assert status.missing_files == ["nemotron-speech-streaming-en-0.6b.nemo"]

    (snapshot_dir / "nemotron-speech-streaming-en-0.6b.nemo").write_bytes(b"model")
    assert model_download.is_repo_cached(
        "nvidia/nemotron-speech-streaming-en-0.6b"
    ) is True


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


def test_health_liveness_is_separate_from_engine_readiness(monkeypatch) -> None:
    monkeypatch.setattr(app_module, "get_session_manager", lambda: _DummySessionManager())
    monkeypatch.setattr(
        app_module,
        "get_engine_manager",
        lambda: SimpleNamespace(
            get_status=lambda: SimpleNamespace(
                current="nemotron",
                status="loading",
                info=None,
                pending={"engine": "nemotron", "status": "loading"},
                message=None,
            )
        ),
    )
    monkeypatch.setattr(app_module, "get_settings", lambda: Settings())
    monkeypatch.setattr(app_module, "collect_diagnostics", lambda settings: {"warnings": []})

    endpoint = _get_route_endpoint(app_module.create_app(), "/health", "GET")
    payload = asyncio.run(endpoint())

    assert payload["status"] == "healthy"
    assert payload["engine"]["status"] == "loading"
    assert payload["engine"]["pending"]["status"] == "loading"


def test_byte_progress_reports_percentage_speed_and_eta(monkeypatch) -> None:
    clock = [0.0]
    monkeypatch.setattr(model_download.time, "monotonic", lambda: clock[0])

    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=100 / 1024**3,
        expected_bytes=100,
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
        model="tiny", repo_id="example/tiny", size_gb=10_000_000 / 1024**3,
        expected_bytes=10_000_000,
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
        model="tiny", repo_id="example/tiny", size_gb=10_000_000 / 1024**3,
        expected_bytes=10_000_000,
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


def test_byte_progress_is_indeterminate_without_a_transfer_total(monkeypatch) -> None:
    monkeypatch.setattr(model_download.time, "monotonic", lambda: 1.0)
    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=10_000_000 / 1024**3,
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=10_000_000 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(
        41, total=None, description="model.bin"
    )
    model_download.report_model_download_bytes(41, 5_000_000)

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == 5_000_000
    assert state["total_bytes"] is None
    assert state["progress_percent"] is None


def test_required_file_progress_stays_indeterminate_until_all_files_are_known(
    tmp_path, monkeypatch
) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
    snapshot_dir = (
        cache_dir
        / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo"
        / "snapshots"
        / "abc123"
    )
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / "config.json").write_bytes(b"x" * 2)

    repo_id = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    model_download.begin_model_download_progress(
        model="tiny", repo_id=repo_id, size_gb=10 / 1024**3,
        initial_bytes=2,
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=10 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id=repo_id,
    )
    model_download.register_model_download_transfer(
        48, total=10, description="model.bin"
    )
    model_download.report_model_download_bytes(48, 5)

    partial = model_download.get_model_download_state()
    assert partial is not None
    assert partial["total_bytes"] is None
    assert partial["progress_percent"] is None

    for transfer_id, filename in enumerate(
        ("preprocessor_config.json", "tokenizer.json", "vocabulary.json"),
        start=49,
    ):
        model_download.register_model_download_transfer(
            transfer_id, total=1, description=filename
        )

    complete = model_download.get_model_download_state()
    assert complete is not None
    assert complete["downloaded_bytes"] == 7
    assert complete["total_bytes"] == 15


def test_partial_blob_resume_is_counted_once_and_finishes_at_total(
    tmp_path, monkeypatch
) -> None:
    cache_dir = tmp_path / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
    repo_dir = (
        cache_dir / "models--example--tiny" / "blobs"
    )
    repo_dir.mkdir(parents=True)
    (repo_dir / "model.incomplete").write_bytes(b"x" * 4)
    snapshot_dir = cache_dir / "models--example--tiny" / "snapshots" / "abc123"
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / "config.json").write_bytes(b"x" * 2)

    # The incomplete blob is not a completed snapshot baseline.  The same
    # four bytes arrive later as tqdm.initial for the active file.
    assert model_download.get_cached_required_bytes("example/tiny") == 2
    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=10 / 1024**3,
        initial_bytes=2,
        expected_bytes=12,
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=10 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(
        42, total=10, initial=4, description="model.bin"
    )
    model_download.report_model_download_bytes(42, 6)

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == 12
    assert state["total_bytes"] == 12
    assert state["progress_percent"] == 99.0

    model_download.mark_model_loading()
    loading = model_download.get_model_download_state()
    assert loading is not None
    assert loading["downloaded_bytes"] == 12
    assert loading["total_bytes"] == 12


def test_repeated_transfer_registration_is_idempotent(monkeypatch) -> None:
    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=10 / 1024**3,
        expected_bytes=10,
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=10 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(43, total=10, initial=4)
    model_download.register_model_download_transfer(43, total=10, initial=4)
    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == 4
    assert state["total_bytes"] == 10

    model_download.report_model_download_bytes(43, 6)
    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == state["total_bytes"] == 10


def test_recreated_transfer_for_same_file_replaces_prior_attempt(monkeypatch) -> None:
    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=10 / 1024**3,
        expected_bytes=10,
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=10 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(
        46, total=10, initial=4, description="model.bin"
    )
    model_download.report_model_download_bytes(46, 3)
    model_download.register_model_download_transfer(
        47, total=10, initial=4, description="model.bin"
    )

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == 4

    model_download.report_model_download_bytes(46, 3)
    model_download.report_model_download_bytes(47, 6)
    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == state["total_bytes"] == 10


def test_multiple_file_transfers_keep_absolute_totals_separate(monkeypatch) -> None:
    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=20 / 1024**3,
        initial_bytes=2,
        expected_bytes=17,
    )
    model_download.update_model_download_state(
        model="tiny",
        size_gb=20 / 1024**3,
        status="downloading",
        phase="downloading",
        repo_id="example/tiny",
    )
    model_download.register_model_download_transfer(
        44, total=10, initial=3, description="model.bin"
    )
    model_download.register_model_download_transfer(
        45, total=5, initial=1, description="config.json"
    )
    model_download.report_model_download_bytes(44, 7)
    model_download.report_model_download_bytes(45, 4)

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == 17
    assert state["total_bytes"] == 17


def test_resumed_bytes_do_not_inflate_transfer_rate(monkeypatch) -> None:
    clock = [0.0]
    monkeypatch.setattr(model_download.time, "monotonic", lambda: clock[0])
    model_download.begin_model_download_progress(
        model="tiny",
        repo_id="example/tiny",
        size_gb=10_000_000 / 1024**3,
        initial_bytes=4_000_000,
        expected_bytes=10_000_000,
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
        model="tiny", repo_id="example/tiny", size_gb=100 / 1024**3,
        expected_bytes=100,
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
            unit="B",
            disable=True,
        ) as progress:
            clock[0] = 2.0
            progress.update(25)

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == 25
    assert state["progress_percent"] == 25.0


def test_huggingface_progress_bridge_ignores_snapshot_item_bar(monkeypatch) -> None:
    monkeypatch.setattr(model_download.time, "monotonic", lambda: 0.0)
    model_download.begin_model_download_progress(
        model="tiny", repo_id="example/tiny", size_gb=100 / 1024**3,
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
            desc="Fetching 1 files",
            total=1,
            unit="it",
            disable=True,
        ) as progress:
            progress.update(1)

    state = model_download.get_model_download_state()
    assert state is not None
    assert state["downloaded_bytes"] == 0
    assert state["total_bytes"] is None
    assert state["progress_percent"] is None


def test_huggingface_progress_bridge_restores_nested_and_failed_contexts() -> None:
    tqdm_module = importlib.import_module("huggingface_hub.utils.tqdm")
    file_download_module = importlib.import_module("huggingface_hub.file_download")
    snapshot_module = importlib.import_module("huggingface_hub._snapshot_download")
    original_tqdm = tqdm_module.tqdm
    original_file_tqdm = file_download_module.tqdm
    original_snapshot_tqdm = snapshot_module.hf_tqdm

    with model_download.track_huggingface_download_progress():
        reporting_tqdm = tqdm_module.tqdm
        assert reporting_tqdm is not original_tqdm
        assert file_download_module.tqdm is reporting_tqdm
        assert snapshot_module.hf_tqdm is reporting_tqdm
        with model_download.track_huggingface_download_progress():
            assert tqdm_module.tqdm is reporting_tqdm
        assert tqdm_module.tqdm is reporting_tqdm
    assert tqdm_module.tqdm is original_tqdm
    assert file_download_module.tqdm is original_file_tqdm
    assert snapshot_module.hf_tqdm is original_snapshot_tqdm

    try:
        with model_download.track_huggingface_download_progress():
            raise RuntimeError("test failure")
    except RuntimeError:
        pass
    assert tqdm_module.tqdm is original_tqdm
