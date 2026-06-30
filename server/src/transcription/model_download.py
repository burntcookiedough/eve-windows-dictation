"""Model download cache checks and shared state."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
import os

ModelDownloadStatus = Literal["missing", "partial", "downloading", "ready", "error"]

_TEMP_FILE_MARKERS = (".incomplete", ".lock", ".tmp", ".temp", ".partial")
_REQUIRED_FILES_BY_REPO: dict[str, tuple[str, ...]] = {
    "mobiuslabsgmbh/faster-whisper-large-v3-turbo": (
        "config.json",
        "model.bin",
        "preprocessor_config.json",
        "tokenizer.json",
        "vocabulary.json",
    ),
    "dropbox-dash/faster-whisper-large-v3-turbo": (
        "config.json",
        "model.bin",
        "preprocessor_config.json",
        "tokenizer.json",
        "vocabulary.json",
    ),
}
_DEFAULT_REQUIRED_FILES = (
    "config.json",
    "model.bin",
    "tokenizer.json",
)


@dataclass(frozen=True)
class ModelDownloadState:
    model: str
    size_gb: float
    status: ModelDownloadStatus
    cached: bool | None = None
    detail: str | None = None
    repo_id: str | None = None
    path: str | None = None
    missing_files: list[str] = field(default_factory=list)
    partial_files: list[str] = field(default_factory=list)
    updated_at: str | None = None


@dataclass(frozen=True)
class ModelCacheStatus:
    repo_id: str
    status: ModelDownloadStatus
    cached: bool
    detail: str
    repo_path: str | None = None
    snapshot_path: str | None = None
    missing_files: list[str] = field(default_factory=list)
    partial_files: list[str] = field(default_factory=list)


_MODEL_DOWNLOAD_STATE: ModelDownloadState | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_hf_cache_dir() -> Path:
    for key in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        value = os.environ.get(key)
        if value:
            return Path(value)

    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return Path(hf_home) / "hub"

    return Path.home() / ".cache" / "huggingface" / "hub"


def _repo_cache_dir(repo_id: str) -> Path | None:
    if "/" not in repo_id:
        return None
    org, name = repo_id.split("/", 1)
    return _get_hf_cache_dir() / f"models--{org}--{name}"


def _required_files(repo_id: str) -> tuple[str, ...]:
    return _REQUIRED_FILES_BY_REPO.get(repo_id, _DEFAULT_REQUIRED_FILES)


def _has_temp_marker(path: Path) -> bool:
    name = path.name.lower()
    return any(marker in name for marker in _TEMP_FILE_MARKERS)


def _collect_partial_files(repo_dir: Path) -> list[str]:
    partials: list[str] = []
    for entry in repo_dir.rglob("*"):
        if entry.is_file() and (_has_temp_marker(entry) or entry.stat().st_size == 0):
            partials.append(str(entry))
    return sorted(partials)


def _snapshot_from_ref(repo_dir: Path) -> Path | None:
    refs_dir = repo_dir / "refs"
    snapshots_dir = repo_dir / "snapshots"
    if not refs_dir.is_dir() or not snapshots_dir.is_dir():
        return None

    for ref_name in ("main", "master"):
        ref = refs_dir / ref_name
        if not ref.is_file():
            continue
        try:
            revision = ref.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not revision:
            continue
        snapshot = snapshots_dir / revision
        if snapshot.is_dir():
            return snapshot
    return None


def _candidate_snapshots(repo_dir: Path) -> list[Path]:
    snapshots_dir = repo_dir / "snapshots"
    if not snapshots_dir.is_dir():
        return []
    ref_snapshot = _snapshot_from_ref(repo_dir)
    snapshots = [entry for entry in snapshots_dir.iterdir() if entry.is_dir()]
    if ref_snapshot is not None:
        snapshots = [ref_snapshot, *[s for s in snapshots if s != ref_snapshot]]
    return snapshots


def get_repo_cache_status(repo_id: str) -> ModelCacheStatus:
    repo_dir = _repo_cache_dir(repo_id)
    if repo_dir is None:
        return ModelCacheStatus(
            repo_id=repo_id,
            status="error",
            cached=False,
            detail="invalid repository id",
        )

    if not repo_dir.exists():
        return ModelCacheStatus(
            repo_id=repo_id,
            status="missing",
            cached=False,
            detail="repository cache directory is missing",
            repo_path=str(repo_dir),
            missing_files=list(_required_files(repo_id)),
        )

    partial_files = _collect_partial_files(repo_dir)
    if partial_files:
        status: ModelDownloadStatus = "downloading" if any(
            path.lower().endswith(".incomplete") or path.lower().endswith(".lock")
            for path in partial_files
        ) else "partial"
        return ModelCacheStatus(
            repo_id=repo_id,
            status=status,
            cached=False,
            detail="temporary or incomplete files are present",
            repo_path=str(repo_dir),
            partial_files=partial_files,
        )

    snapshots = _candidate_snapshots(repo_dir)
    if not snapshots:
        return ModelCacheStatus(
            repo_id=repo_id,
            status="missing",
            cached=False,
            detail="no snapshots are present",
            repo_path=str(repo_dir),
            missing_files=list(_required_files(repo_id)),
        )

    required = _required_files(repo_id)
    best_missing: list[str] = list(required)
    best_snapshot: Path | None = None
    for snapshot in snapshots:
        missing = [name for name in required if not (snapshot / name).is_file()]
        if len(missing) < len(best_missing):
            best_missing = missing
            best_snapshot = snapshot
        if not missing:
            return ModelCacheStatus(
                repo_id=repo_id,
                status="ready",
                cached=True,
                detail="complete snapshot is cached",
                repo_path=str(repo_dir),
                snapshot_path=str(snapshot),
            )

    return ModelCacheStatus(
        repo_id=repo_id,
        status="partial",
        cached=False,
        detail="snapshot is missing required files",
        repo_path=str(repo_dir),
        snapshot_path=str(best_snapshot) if best_snapshot else None,
        missing_files=best_missing,
    )


def is_repo_cached(repo_id: str) -> bool:
    return get_repo_cache_status(repo_id).status == "ready"


def update_model_download_state(
    *,
    model: str,
    size_gb: float,
    status: ModelDownloadStatus,
    cached: bool | None = None,
    detail: str | None = None,
    repo_id: str | None = None,
    path: str | None = None,
    missing_files: list[str] | None = None,
    partial_files: list[str] | None = None,
) -> None:
    global _MODEL_DOWNLOAD_STATE
    _MODEL_DOWNLOAD_STATE = ModelDownloadState(
        model=model,
        size_gb=size_gb,
        status=status,
        cached=cached,
        detail=detail,
        repo_id=repo_id,
        path=path,
        missing_files=missing_files or [],
        partial_files=partial_files or [],
        updated_at=_now_iso(),
    )


def get_model_download_state() -> dict | None:
    if _MODEL_DOWNLOAD_STATE is None:
        return None
    return asdict(_MODEL_DOWNLOAD_STATE)
