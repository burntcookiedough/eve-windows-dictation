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


def test_nsis_web_identity_and_data_retention_are_explicit() -> None:
    package_json = _load_package_json()
    build = package_json.get("build", {})
    nsis_web = build.get("nsisWeb", {})

    assert package_json.get("name") == "murmur"
    assert build.get("appId") == "com.murmur.app"
    assert build.get("productName") == "Eve"
    assert build.get("executableName") == "Eve"
    assert nsis_web == {
        "guid": "0204d005-75b3-5b31-b1f6-ef2831e2b204",
        "oneClick": True,
        "deleteAppDataOnUninstall": False,
        "artifactName": "Eve.Web.Setup.${version}.${ext}",
        "shortcutName": "Eve",
        "uninstallDisplayName": "Eve ${version}",
    }


def test_main_build_enters_through_identity_bootstrap() -> None:
    build_script = (ROOT / "app" / "scripts" / "build-main.js").read_text(
        encoding="utf-8"
    )
    bootstrap = (ROOT / "app" / "src" / "main" / "bootstrap.ts").read_text(
        encoding="utf-8"
    )
    bootstrap_core = (
        ROOT / "app" / "src" / "main" / "bootstrap-core.ts"
    ).read_text(encoding="utf-8")

    assert "src/main/bootstrap.ts" in build_script
    assert "requestSingleInstanceLock" in bootstrap_core
    assert "setPath('userData'" in bootstrap_core
    assert "import('./index.js')" in bootstrap
    assert "await bootstrapApplication" in bootstrap


def test_electron_builder_publish_includes_github() -> None:
    package_json = _load_package_json()
    publish = package_json.get("build", {}).get("publish")
    providers = _extract_publish_providers(publish)
    assert "github" in providers


def test_electron_builder_publish_targets_release_repository() -> None:
    package_json = _load_package_json()
    publish = package_json.get("build", {}).get("publish")
    github_publishers = [
        entry
        for entry in publish
        if isinstance(entry, dict) and entry.get("provider") == "github"
    ]
    assert github_publishers == [
        {
            "provider": "github",
            "owner": "burntcookiedough",
            "repo": "eve-windows-dictation",
        }
    ]


def test_windows_packaging_never_publishes_implicitly() -> None:
    package_json = _load_package_json()
    package_script = package_json.get("scripts", {}).get("package:win", "")
    assert "--publish never" in package_script


def test_release_verification_targets_eve_with_legacy_payload_name() -> None:
    contents = (ROOT / "scripts" / "release-verify.ps1").read_text(
        encoding="utf-8"
    )
    assert '"Eve.Web.Setup.$ExpectedVersion.exe"' in contents
    assert '"Eve.exe"' in contents
    assert '"murmur-$ExpectedVersion-x64.nsis.7z"' in contents


def test_release_workflow_installs_extras_and_uploads_payloads() -> None:
    workflow_path = ROOT / ".github" / "workflows" / "release.yml"
    contents = workflow_path.read_text(encoding="utf-8")
    assert "--extra all" in contents
    assert "prepare-python-runtime.ps1" in contents
    assert "portable Python imports" in contents
    assert "Verify packaged Python imports" in contents
    assert "release\\win-unpacked\\resources\\server" in contents
    assert "torch, nemo.collections.asr" in contents
    assert '$health.engine.status -eq "ready"' in contents
    assert '$health.model_download.status -eq "ready"' in contents
    assert "$maxAssetBytes = 2100000000" in contents
    assert "uv run --no-sync pytest" in contents
    assert "--group dev" in contents
    assert "GH_TOKEN" not in contents
    assert '$releaseDir = "app\\release\\nsis-web"' in contents
    assert "app/release/nsis-web/*.exe" in contents
    assert "app/release/nsis-web/*.yml" in contents
    assert "app/release/nsis-web/*.blockmap" in contents
    assert "app/release/nsis-web/*.7z" in contents
    assert "app/release/**/*.exe" not in contents


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
    assert "!.venv/**/pip*" not in filters
    assert "!.venv/**/wheel*" not in filters
    assert "!.venv/**/setuptools*" not in filters
    assert "!.venv/Lib/site-packages/pip/**" in filters
    assert "!.venv/Lib/site-packages/wheel/**" in filters
    assert "!.venv/Lib/site-packages/setuptools/**" in filters
    assert "!.venv/Lib/site-packages/**/test/**" in filters
    assert "!.venv/Lib/site-packages/**/tests/**" in filters
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


def test_version_check_includes_all_release_metadata() -> None:
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

    dry_run = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "version.py"),
            "bump",
            version,
            "--dry-run",
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert dry_run.returncode == 0, dry_run.stderr
    dry_run_output = dry_run.stdout.replace("\\", "/")
    for path in (
        "app/package.json",
        "server/pyproject.toml",
        "server/src/version.py",
        "server/uv.lock",
        "README.md",
        "scripts/release-verify.ps1",
    ):
        assert path in dry_run_output
