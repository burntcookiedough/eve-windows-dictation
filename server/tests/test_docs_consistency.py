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

    assert "uv sync --extra whisper --group dev --frozen" in building
    assert "uv sync --python 3.11 --no-dev --extra release --frozen" in building
    assert "bun run package:win" in building
    assert "nsis-web" in building
    assert "prepare-python-runtime.ps1" in building
    assert ".runtime" in building
    assert "nsis-web" in readme

    build_guide = ROOT / "docs" / "development" / "building.md"
    assert "(docs/development/building.md)" in readme
    assert build_guide.is_file()
