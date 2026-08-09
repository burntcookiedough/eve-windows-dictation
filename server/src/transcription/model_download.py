"""Model download cache checks and shared state."""

from __future__ import annotations

from collections import deque
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
import importlib
from pathlib import Path
import shutil
import threading
import time
from typing import Iterator, Literal
import os

ModelDownloadStatus = Literal["missing", "partial", "downloading", "ready", "error"]
ModelDownloadPhase = Literal["checking", "downloading", "loading", "ready", "error"]

_TEMP_FILE_MARKERS = (".incomplete", ".lock", ".tmp", ".temp", ".partial")
_REQUIRED_FILES_BY_REPO: dict[str, tuple[str, ...]] = {
    "nvidia/nemotron-speech-streaming-en-0.6b": (
        "nemotron-speech-streaming-en-0.6b.nemo",
    ),
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
_MIB = 1024**2
_GIB = 1024**3
_MIN_DOWNLOAD_CUSHION_BYTES = 512 * _MIB


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
    phase: ModelDownloadPhase | None = None
    progress_percent: float | None = None
    downloaded_bytes: int | None = None
    total_bytes: int | None = None
    bytes_per_second: int | None = None
    eta_seconds: int | None = None
    current_file: str | None = None
    started_at: str | None = None


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


@dataclass(frozen=True)
class DownloadDiskPreflight:
    available_bytes: int
    required_bytes: int
    remaining_estimated_bytes: int
    cushion_bytes: int
    inspected_path: str


class DownloadDiskPreflightError(RuntimeError):
    """The selected model cannot safely begin its existing cache download."""


@dataclass(frozen=True)
class _TransferProgress:
    """Absolute byte state for one active/completed file transfer."""

    initial_bytes: int
    current_bytes: int
    total_bytes: int | None
    label: str


_MODEL_DOWNLOAD_STATE: ModelDownloadState | None = None
_PROGRESS_LOCK = threading.RLock()
_PROGRESS_STARTED_AT: str | None = None
_PROGRESS_BASELINE_BYTES = 0
_PROGRESS_EXPECTED_BYTES: int | None = None
_PROGRESS_TRANSFERS: dict[int, _TransferProgress] = {}
_PROGRESS_SAMPLES: deque[tuple[float, int]] = deque(maxlen=256)
_PROGRESS_CURRENT_FILE: str | None = None
_PROGRESS_ACTIVE_MODEL: str | None = None
_PROGRESS_ACTIVE_REPO: str | None = None
_NEXT_TRANSFER_ID = 0
_TQDM_PATCH_LOCK = threading.RLock()


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


def get_cached_required_bytes(repo_id: str) -> int:
    """Return completed required-file bytes from the most complete snapshot.

    Hugging Face stores resumable transfers in ``blobs/*.incomplete`` until
    they are promoted into a snapshot.  Those partial bytes are intentionally
    excluded here and are added once from the transfer's absolute ``initial``
    value by the progress bridge.
    """
    repo_dir = _repo_cache_dir(repo_id)
    if repo_dir is None or not repo_dir.exists():
        return 0

    required = _required_files(repo_id)
    totals: list[int] = []
    for snapshot in _candidate_snapshots(repo_dir):
        total = 0
        for filename in required:
            path = snapshot / filename
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:
                continue
        totals.append(total)
    return max(totals, default=0)


def check_download_disk_space(repo_id: str, model_size_gb: float) -> DownloadDiskPreflight:
    """Check free capacity for one selected Hugging Face repo without touching cache data.

    Model metadata is approximate, so the remaining estimate includes the larger of a
    10% cushion or 512 MiB. Only the selected repo's required-file metadata is read.
    """
    cache_dir = _get_hf_cache_dir()
    inspected = cache_dir
    while not inspected.exists() and inspected.parent != inspected:
        inspected = inspected.parent
    if not inspected.exists():
        raise DownloadDiskPreflightError("Cannot inspect the selected model cache filesystem.")
    try:
        available = shutil.disk_usage(inspected).free
    except OSError as exc:
        raise DownloadDiskPreflightError("Cannot inspect free space for the selected model cache filesystem.") from exc

    estimated = max(0, int(model_size_gb * _GIB))
    cached = get_cached_required_bytes(repo_id)
    remaining = max(0, estimated - cached)
    cushion = max(int(estimated * 0.10), _MIN_DOWNLOAD_CUSHION_BYTES)
    required = remaining + cushion
    result = DownloadDiskPreflight(available, required, remaining, cushion, str(inspected))
    if available < required:
        raise DownloadDiskPreflightError(
            f"Not enough free space to prepare the selected model (needs about {required / _GIB:.1f} GB free; {available / _GIB:.1f} GB available)."
        )
    return result


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
    phase: ModelDownloadPhase | None = None,
    progress_percent: float | None = None,
    downloaded_bytes: int | None = None,
    total_bytes: int | None = None,
    bytes_per_second: int | None = None,
    eta_seconds: int | None = None,
    current_file: str | None = None,
    started_at: str | None = None,
) -> None:
    global _MODEL_DOWNLOAD_STATE
    with _PROGRESS_LOCK:
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
            phase=phase,
            progress_percent=progress_percent,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
            bytes_per_second=bytes_per_second,
            eta_seconds=eta_seconds,
            current_file=current_file,
            started_at=started_at,
        )


def begin_model_download_progress(
    *,
    model: str,
    repo_id: str,
    size_gb: float,
    initial_bytes: int = 0,
    expected_bytes: int | None = None,
) -> None:
    """Reset byte-level progress before Hugging Face starts a download.

    ``size_gb`` is an end-user estimate and is deliberately not used as a
    determinate byte total.  The total becomes determinate only after a
    transfer exposes a byte total (or the caller supplies one explicitly).
    """
    global _PROGRESS_STARTED_AT
    global _PROGRESS_BASELINE_BYTES
    global _PROGRESS_EXPECTED_BYTES
    global _PROGRESS_CURRENT_FILE
    global _PROGRESS_ACTIVE_MODEL
    global _PROGRESS_ACTIVE_REPO

    now = time.monotonic()
    with _PROGRESS_LOCK:
        _PROGRESS_STARTED_AT = _now_iso()
        _PROGRESS_BASELINE_BYTES = max(0, int(initial_bytes))
        known_total = int(expected_bytes) if expected_bytes is not None else 0
        _PROGRESS_EXPECTED_BYTES = known_total or None
        _PROGRESS_TRANSFERS.clear()
        _PROGRESS_SAMPLES.clear()
        _PROGRESS_SAMPLES.append((now, _downloaded_bytes_locked()))
        _PROGRESS_CURRENT_FILE = None
        _PROGRESS_ACTIVE_MODEL = model
        _PROGRESS_ACTIVE_REPO = repo_id


def _friendly_download_item(description: str | None, total: int | None) -> str:
    normalized = (description or "").lower()
    if "model.bin" in normalized or (total is not None and total >= 50 * 1024**2):
        return "model weights"
    for filename, label in (
        ("tokenizer", "tokenizer"),
        ("vocabulary", "vocabulary"),
        ("preprocessor", "audio configuration"),
        ("config", "model configuration"),
    ):
        if filename in normalized:
            return label
    return "model files"


def _next_transfer_id() -> int:
    global _NEXT_TRANSFER_ID
    with _PROGRESS_LOCK:
        _NEXT_TRANSFER_ID += 1
        return _NEXT_TRANSFER_ID


def register_model_download_transfer(
    transfer_id: int,
    *,
    total: int | None,
    initial: int = 0,
    description: str | None = None,
    unit: str = "B",
) -> None:
    """Register one byte transfer reported by huggingface_hub.

    Hugging Face also creates an item-count progress bar for snapshot-level
    concurrency.  It is intentionally ignored here so file byte totals are
    never mixed with the number of files.
    """
    global _PROGRESS_CURRENT_FILE

    if str(unit or "").lower() not in {"b", "byte", "bytes"}:
        return

    with _PROGRESS_LOCK:
        label = _friendly_download_item(
            description,
            total,
        )
        known_total = int(total) if total is not None and total > 0 else None
        existing = _PROGRESS_TRANSFERS.get(transfer_id)
        if existing is None:
            transfer = _TransferProgress(
                initial_bytes=max(0, int(initial)),
                current_bytes=max(0, int(initial)),
                total_bytes=known_total,
                label=label,
            )
        else:
            # A retry can re-enter the progress-bar constructor.  Preserve
            # absolute progress and only fill in a total learned later.
            transfer = replace(
                existing,
                total_bytes=existing.total_bytes or known_total,
                label=label,
            )
        _PROGRESS_TRANSFERS[transfer_id] = transfer
        _PROGRESS_CURRENT_FILE = transfer.label
        _PROGRESS_SAMPLES.clear()
        _PROGRESS_SAMPLES.append((time.monotonic(), _downloaded_bytes_locked()))


def report_model_download_bytes(
    transfer_id: int,
    delta: int | float,
    *,
    description: str | None = None,
) -> None:
    """Add a byte delta from a Hugging Face HTTP or Xet transfer callback."""
    global _PROGRESS_CURRENT_FILE

    byte_delta = max(0, int(delta))
    if byte_delta == 0:
        return
    now = time.monotonic()
    with _PROGRESS_LOCK:
        existing = _PROGRESS_TRANSFERS.get(transfer_id)
        if existing is None:
            existing = _TransferProgress(
                initial_bytes=0,
                current_bytes=0,
                total_bytes=None,
                label=_friendly_download_item(description, None),
            )
        next_current = existing.current_bytes + byte_delta
        if existing.total_bytes is not None:
            next_current = min(next_current, existing.total_bytes)
        updated = replace(
            existing,
            current_bytes=next_current,
        )
        _PROGRESS_TRANSFERS[transfer_id] = updated
        _PROGRESS_CURRENT_FILE = updated.label
        _PROGRESS_SAMPLES.append((now, _downloaded_bytes_locked()))


def _downloaded_bytes_locked() -> int:
    return _PROGRESS_BASELINE_BYTES + sum(
        transfer.current_bytes for transfer in _PROGRESS_TRANSFERS.values()
    )


def _expected_bytes_locked() -> int | None:
    if _PROGRESS_EXPECTED_BYTES is not None:
        return _PROGRESS_EXPECTED_BYTES
    if any(transfer.total_bytes is None for transfer in _PROGRESS_TRANSFERS.values()):
        return None
    if not _PROGRESS_TRANSFERS:
        return None
    return _PROGRESS_BASELINE_BYTES + sum(
        transfer.total_bytes or 0 for transfer in _PROGRESS_TRANSFERS.values()
    )


def _progress_metrics() -> dict[str, int | float | str | None]:
    now = time.monotonic()
    downloaded = _downloaded_bytes_locked()
    total = _expected_bytes_locked()
    rate = 0.0

    if _PROGRESS_SAMPLES:
        baseline_time, baseline_bytes = _PROGRESS_SAMPLES[0]
        for sample_time, sample_bytes in _PROGRESS_SAMPLES:
            if now - sample_time <= 30:
                baseline_time, baseline_bytes = sample_time, sample_bytes
                break
        elapsed = now - baseline_time
        if elapsed >= 1:
            rate = max(0.0, (downloaded - baseline_bytes) / elapsed)
        if now - _PROGRESS_SAMPLES[-1][0] > 15:
            rate = 0.0

    percent = (
        min(99.0, downloaded / total * 100)
        if total is not None and total > 0
        else None
    )
    remaining = max(0, total - downloaded) if total is not None else None
    eta = round(remaining / rate) if rate > 1024 and remaining and remaining > 0 else None
    return {
        "progress_percent": round(percent, 1) if percent is not None else None,
        "downloaded_bytes": downloaded,
        "total_bytes": total,
        "bytes_per_second": round(rate) if rate > 0 else None,
        "eta_seconds": eta,
        "current_file": _PROGRESS_CURRENT_FILE,
        "started_at": _PROGRESS_STARTED_AT,
    }


def mark_model_loading() -> None:
    """Switch the visible stage after download and before model initialization."""
    global _MODEL_DOWNLOAD_STATE
    with _PROGRESS_LOCK:
        if _MODEL_DOWNLOAD_STATE is None:
            return
        metrics = _progress_metrics()
        downloaded = int(metrics["downloaded_bytes"] or 0)
        _MODEL_DOWNLOAD_STATE = replace(
            _MODEL_DOWNLOAD_STATE,
            status="downloading",
            cached=True,
            detail="download complete; loading model",
            phase="loading",
            progress_percent=100.0,
            downloaded_bytes=downloaded,
            total_bytes=metrics["total_bytes"],
            bytes_per_second=None,
            eta_seconds=None,
            current_file=None,
            started_at=metrics["started_at"],
            updated_at=_now_iso(),
        )


@contextmanager
def track_huggingface_download_progress() -> Iterator[None]:
    """Temporarily bridge huggingface_hub byte progress into Murmur state."""
    with _TQDM_PATCH_LOCK:
        try:
            tqdm_module = importlib.import_module("huggingface_hub.utils.tqdm")
            original_tqdm = tqdm_module.tqdm
        except (ImportError, AttributeError):
            yield
            return

        if getattr(original_tqdm, "_murmur_progress_bridge", False):
            yield
            return

        class ReportingTqdm(original_tqdm):
            _murmur_progress_bridge = True

            def __init__(self, *args, **kwargs):
                self._murmur_transfer_id = _next_transfer_id()
                self._murmur_description = kwargs.get("desc")
                self._murmur_unit = str(kwargs.get("unit", "it"))
                self._murmur_is_byte_transfer = self._murmur_unit.lower() in {
                    "b",
                    "byte",
                    "bytes",
                }
                super().__init__(*args, **kwargs)
                register_model_download_transfer(
                    self._murmur_transfer_id,
                    total=int(self.total) if self.total is not None else None,
                    initial=int(self.n),
                    description=self._murmur_description,
                    unit=self._murmur_unit,
                )
                self._murmur_last_n = int(self.n)

            def update(self, n=1):
                result = super().update(n)
                if getattr(self, "disable", False):
                    delta = max(0, int(n))
                    self._murmur_last_n += delta
                else:
                    current_n = int(self.n)
                    delta = max(0, current_n - self._murmur_last_n)
                    self._murmur_last_n = current_n
                if self._murmur_is_byte_transfer:
                    report_model_download_bytes(
                        self._murmur_transfer_id,
                        delta,
                        description=self._murmur_description,
                    )
                return result

        patched_modules: list[tuple[object, str, object]] = []
        for module_name, attribute in (
            ("huggingface_hub.utils.tqdm", "tqdm"),
            ("huggingface_hub.file_download", "tqdm"),
            ("huggingface_hub._snapshot_download", "hf_tqdm"),
        ):
            try:
                module = importlib.import_module(module_name)
                original = getattr(module, attribute)
            except (ImportError, AttributeError):
                continue
            if getattr(original, "_murmur_progress_bridge", False):
                continue
            setattr(module, attribute, ReportingTqdm)
            patched_modules.append((module, attribute, original))
        try:
            yield
        finally:
            for module, attribute, original in reversed(patched_modules):
                setattr(module, attribute, original)


def get_model_download_state() -> dict | None:
    with _PROGRESS_LOCK:
        if _MODEL_DOWNLOAD_STATE is None:
            return None
        state = asdict(_MODEL_DOWNLOAD_STATE)
        if (
            _MODEL_DOWNLOAD_STATE.status == "downloading"
            and _MODEL_DOWNLOAD_STATE.phase == "downloading"
            and _MODEL_DOWNLOAD_STATE.model == _PROGRESS_ACTIVE_MODEL
            and _MODEL_DOWNLOAD_STATE.repo_id == _PROGRESS_ACTIVE_REPO
        ):
            state.update(_progress_metrics())
        return state
