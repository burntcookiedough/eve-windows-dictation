"""Tests for Windows installer smoke script presence."""

from pathlib import Path


def test_installer_smoke_script_exists_and_targets_health() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    script_path = repo_root / "scripts" / "installer-smoke.ps1"

    assert script_path.is_file()

    contents = script_path.read_text(encoding="utf-8")
    assert "http://127.0.0.1:51717/health" in contents
    assert "model_download" in contents
    assert "RequireCuda" in contents
    assert "RequireVcRedist" in contents
    assert "RequireDriverMinimum" in contents
    assert "RequireModelDownload" in contents
