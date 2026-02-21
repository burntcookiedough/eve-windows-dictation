"""Model download cache checks and shared state."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
import os

ModelDownloadStatus = Literal["ready", "downloading", "error"]


@dataclass(frozen=True)
class ModelDownloadState:
    model: str
    size_gb: float
    status: ModelDownloadStatus
    cached: bool | None = None
    detail: str | None = None
    updated_at: str | None = None


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


def is_repo_cached(repo_id: str) -> bool:
    repo_dir = _repo_cache_dir(repo_id)
    if repo_dir is None:
        return False

    snapshots_dir = repo_dir / "snapshots"
    if snapshots_dir.is_dir():
        if any(entry.is_dir() for entry in snapshots_dir.iterdir()):
            return True

    refs_dir = repo_dir / "refs"
    if refs_dir.is_dir():
        if any(entry.is_file() for entry in refs_dir.iterdir()):
            return True

    return False


def update_model_download_state(
    *,
    model: str,
    size_gb: float,
    status: ModelDownloadStatus,
    cached: bool | None = None,
    detail: str | None = None,
) -> None:
    global _MODEL_DOWNLOAD_STATE
    _MODEL_DOWNLOAD_STATE = ModelDownloadState(
        model=model,
        size_gb=size_gb,
        status=status,
        cached=cached,
        detail=detail,
        updated_at=_now_iso(),
    )


def get_model_download_state() -> dict | None:
    if _MODEL_DOWNLOAD_STATE is None:
        return None
    return asdict(_MODEL_DOWNLOAD_STATE)
