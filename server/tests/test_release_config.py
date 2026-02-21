"""Tests for release/build configuration expectations."""

from __future__ import annotations

import json
from pathlib import Path


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


def test_release_workflow_installs_extras_and_uploads_payloads() -> None:
    workflow_path = ROOT / ".github" / "workflows" / "release.yml"
    contents = workflow_path.read_text(encoding="utf-8")
    assert "uv sync --extra all" in contents
    assert "app/release/*.yml" in contents
    assert "app/release/*.blockmap" in contents
    assert "app/release/*.7z" in contents or "app/release/*.zip" in contents
