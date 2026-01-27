"""Ensure src/ is on sys.path for local runs."""

from __future__ import annotations

import sys
from pathlib import Path


def _add_src_to_path() -> None:
    root = Path(__file__).resolve().parent
    src_path = root / "src"
    if src_path.is_dir():
        sys.path.insert(0, str(src_path))


_add_src_to_path()
