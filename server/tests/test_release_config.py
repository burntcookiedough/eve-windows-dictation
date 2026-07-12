"""Tests for release/build configuration expectations."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def _load_package_json() -> dict:
    package_path = ROOT / "app" / "package.json"
    with package_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _extract_targets(target_value: object) -> list[str]:
    if isinstance(target_value, str):
        return [target_value]
    targets: list[str] = []
    if isinstance(target_value, list):
        for entry in target_value:
            if isinstance(entry, str):
                targets.append(entry)
            elif isinstance(entry, dict):
                target = entry.get("target")
                if isinstance(target, str):
                    targets.append(target)
    return targets


def _extract_publish_providers(publish_value: object) -> list[str]:
    providers: list[str] = []
    if isinstance(publish_value, dict):
        provider = publish_value.get("provider")
        if isinstance(provider, str):
            providers.append(provider)
    if isinstance(publish_value, list):
        for entry in publish_value:
            if isinstance(entry, dict):
                provider = entry.get("provider")
                if isinstance(provider, str):
                    providers.append(provider)
    return providers


def test_electron_builder_windows_target_is_nsis_web() -> None:
    package_json = _load_package_json()
    win_config = package_json.get("build", {}).get("win", {})
    targets = _extract_targets(win_config.get("target"))
    assert "nsis-web" in targets


def test_electron_builder_publish_includes_github() -> None:
    package_json = _load_package_json()
    publish = package_json.get("build", {}).get("publish")
    providers = _extract_publish_providers(publish)
    assert "github" in providers


def test_windows_packaging_never_publishes_implicitly() -> None:
    package_json = _load_package_json()
    package_script = package_json.get("scripts", {}).get("package:win", "")
    assert "--publish never" in package_script


def test_release_workflow_installs_extras_and_uploads_payloads() -> None:
    workflow_path = ROOT / ".github" / "workflows" / "release.yml"
    contents = workflow_path.read_text(encoding="utf-8")
    assert "--extra all" in contents
    assert "prepare-python-runtime.ps1" in contents
    assert "portable Python imports" in contents
    assert "torch, nemo.collections.asr" in contents
    assert '$health.engine.status -eq "ready"' in contents
    assert '$health.model_download.status -eq "ready"' in contents
    assert "$maxAssetBytes = 2100000000" in contents
    assert "uv run --no-sync pytest" in contents
    assert "--group dev" in contents
    assert "GH_TOKEN" not in contents
    assert 'Get-ChildItem "app\\release" -Recurse -File' in contents
    assert "app/release/**/*.yml" in contents
    assert "app/release/**/*.blockmap" in contents
    assert "app/release/**/*.7z" in contents or "app/release/**/*.zip" in contents


def test_packaging_includes_relocatable_runtime() -> None:
    package_json = _load_package_json()
    resources = package_json.get("build", {}).get("extraResources", [])
    filters = [
        entry
        for resource in resources
        if isinstance(resource, dict)
        for entry in resource.get("filter", [])
        if isinstance(entry, str)
    ]
    assert ".runtime/**/*" in filters
    assert "!.venv/Lib/site-packages/**/*.lib" in filters
    assert "!.venv/Lib/site-packages/torch/include/**" in filters
    assert "!.runtime/Lib/test/**" in filters


def test_bundled_defaults_are_hardware_neutral() -> None:
    settings = json.loads((ROOT / "server" / "settings.json").read_text(encoding="utf-8"))
    assert settings["engine_preference_mode"] == "auto"
    assert settings["whisper_device"] == "auto"
    assert settings["whisper_compute_type"] == "auto"


def test_ci_runs_app_and_server_tests() -> None:
    contents = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "bun test" in contents
    assert "uv run --no-sync pytest" in contents
    assert "timeout-minutes: 30" in contents


def test_server_manager_uses_portable_runtime_and_user_settings() -> None:
    contents = (ROOT / "app" / "src" / "main" / "services" / "server-manager.ts").read_text(
        encoding="utf-8"
    )
    assert "path.join(serverDir, '.runtime', 'python.exe')" in contents
    assert "path.join(serverDir, '.venv', 'Lib', 'site-packages')" in contents
    assert "PYTHONPATH" in contents
    assert "MURMUR_SETTINGS_FILE" in contents
    assert "path.join(app.getPath('userData'), 'server-settings.json')" in contents


def test_runtime_preparation_script_uses_uv_managed_python() -> None:
    contents = (ROOT / "scripts" / "prepare-python-runtime.ps1").read_text(encoding="utf-8")
    assert "uv python install" in contents
    assert "uv python find --managed-python" in contents
    assert 'Join-Path $runtimePath "python.exe"' in contents


def test_version_check_includes_readme_badge() -> None:
    version = _load_package_json()["version"]
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "version.py"),
            "check",
            "--tag",
            f"v{version}",
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert f"Version check passed: {version}" in completed.stdout
