"""Documentation consistency checks for installer and build flow."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_installer_dependencies_mentions_runtime_requirements() -> None:
    contents = _read("docs/installer-dependencies.md")
    lowered = contents.lower()
    assert "nsis-web" in contents
    assert "visual c++ redistributable" in lowered
    assert "hugging face" in lowered
    assert "first run" in lowered


def test_build_docs_match_packaging_flow() -> None:
    building = _read("docs/development/building.md")
    readme = _read("README.md")

    for content in (building, readme):
        assert "uv sync" in content

    assert "nsis-web" in building
    assert "nsis-web" in readme
    assert "prepare-python-runtime.ps1" in building
    assert ".runtime" in building
