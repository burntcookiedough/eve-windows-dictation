"""Tests for Windows installer smoke script presence."""

from pathlib import Path


def test_installer_smoke_script_exists_and_targets_health() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    script_path = repo_root / "scripts" / "installer-smoke.ps1"

    assert script_path.is_file()

    contents = script_path.read_text(encoding="utf-8")
    assert "Wait-For-PidFile" in contents
    assert "server.pid" in contents
    assert "Removing stale PID file" in contents
    assert "StartedAfter" in contents
    assert "http://127.0.0.1:$($pidData.port)/health" in contents
    assert "ExpectedVersion" in contents
    assert "Version mismatch" in contents
    assert '"/D=$InstallDir"' in contents
    assert "model_download" in contents
    assert "MURMUR_ENGINE" in contents
    assert "RequireCuda" in contents
    assert "RequireVcRedist" in contents
    assert "RequireDriverMinimum" in contents
    assert "RequireModelDownload" in contents
    assert '"$env:LOCALAPPDATA\\Programs\\Eve"' in contents
    assert '"Eve*Setup*.exe"' in contents
    assert '"Uninstall Eve.exe"' in contents
    assert '"Uninstall Murmur.exe"' in contents
    assert '"Eve.exe"' in contents
    assert 'Get-Process -Name "Eve","Murmur"' in contents
