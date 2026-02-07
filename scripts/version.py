#!/usr/bin/env python3
"""Manage Murmur version consistency across app/server/user-facing files."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path
from urllib.parse import quote, unquote

ROOT = Path(__file__).resolve().parents[1]
APP_PACKAGE = ROOT / "app" / "package.json"
SERVER_PYPROJECT = ROOT / "server" / "pyproject.toml"
SERVER_VERSION_FILE = ROOT / "server" / "src" / "version.py"
README = ROOT / "README.md"

SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)

SERVER_VERSION_RE = re.compile(r'^SERVER_VERSION\s*=\s*"([^"]+)"\s*$', re.MULTILINE)
PYPROJECT_VERSION_RE = re.compile(r'^version\s*=\s*"([^"]+)"\s*$', re.MULTILINE)
README_BADGE_RE = re.compile(
    r"(img\.shields\.io/badge/version-)([^-]+)(-orange\?style=flat-square)"
)


def validate_semver(version: str) -> bool:
    return bool(SEMVER_RE.fullmatch(version))


def normalize_tag(tag: str) -> str:
    value = tag[1:] if tag.startswith("v") else tag
    return value.strip()


def read_app_version() -> str:
    data = json.loads(APP_PACKAGE.read_text(encoding="utf-8"))
    version = data.get("version")
    if not isinstance(version, str):
        raise ValueError(f"Missing string version in {APP_PACKAGE}")
    return version


def read_server_pyproject_version() -> str:
    data = tomllib.loads(SERVER_PYPROJECT.read_text(encoding="utf-8"))
    version = data.get("project", {}).get("version")
    if not isinstance(version, str):
        raise ValueError(f"Missing [project].version in {SERVER_PYPROJECT}")
    return version


def read_server_source_version() -> str:
    content = SERVER_VERSION_FILE.read_text(encoding="utf-8")
    match = SERVER_VERSION_RE.search(content)
    if not match:
        raise ValueError(f"Could not find SERVER_VERSION in {SERVER_VERSION_FILE}")
    return match.group(1)


def read_readme_badge_version() -> str:
    content = README.read_text(encoding="utf-8")
    match = README_BADGE_RE.search(content)
    if not match:
        raise ValueError(f"Could not find version badge in {README}")
    return unquote(match.group(2))


def collect_versions() -> dict[str, str]:
    return {
        "app/package.json": read_app_version(),
        "server/pyproject.toml": read_server_pyproject_version(),
        "server/src/version.py": read_server_source_version(),
        "README.md badge": read_readme_badge_version(),
    }


def write_app_version(version: str) -> None:
    data = json.loads(APP_PACKAGE.read_text(encoding="utf-8"))
    data["version"] = version
    APP_PACKAGE.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def write_server_pyproject_version(version: str) -> None:
    content = SERVER_PYPROJECT.read_text(encoding="utf-8")
    replacement_count = 0

    def replacer(match: re.Match[str]) -> str:
        nonlocal replacement_count
        replacement_count += 1
        if replacement_count == 1:
            return f'version = "{version}"'
        return match.group(0)

    updated = PYPROJECT_VERSION_RE.sub(replacer, content)
    if replacement_count == 0:
        raise ValueError(f"Could not update version in {SERVER_PYPROJECT}")
    SERVER_PYPROJECT.write_text(updated, encoding="utf-8")


def write_server_source_version(version: str) -> None:
    content = SERVER_VERSION_FILE.read_text(encoding="utf-8")
    updated, count = SERVER_VERSION_RE.subn(
        f'SERVER_VERSION = "{version}"', content, count=1
    )
    if count != 1:
        raise ValueError(f"Could not update SERVER_VERSION in {SERVER_VERSION_FILE}")
    SERVER_VERSION_FILE.write_text(updated, encoding="utf-8")


def write_readme_badge_version(version: str) -> None:
    encoded_version = quote(version, safe=".")
    content = README.read_text(encoding="utf-8")
    updated, count = README_BADGE_RE.subn(
        rf"\g<1>{encoded_version}\g<3>",
        content,
        count=1,
    )
    if count != 1:
        raise ValueError(f"Could not update version badge in {README}")
    README.write_text(updated, encoding="utf-8")


def check_versions(expected_tag: str | None = None) -> int:
    versions = collect_versions()
    unique_versions = set(versions.values())

    if len(unique_versions) != 1:
        print("Version mismatch detected:", file=sys.stderr)
        for source, value in versions.items():
            print(f"  - {source}: {value}", file=sys.stderr)
        return 1

    version = next(iter(unique_versions))
    if not validate_semver(version):
        print(f"Invalid semantic version detected: {version}", file=sys.stderr)
        return 1

    if expected_tag is not None:
        normalized = normalize_tag(expected_tag)
        if not validate_semver(normalized):
            print(f"Tag is not valid semantic version: {expected_tag}", file=sys.stderr)
            return 1
        if normalized != version:
            print(
                f"Tag/version mismatch: tag {expected_tag} does not match repository version {version}",
                file=sys.stderr,
            )
            return 1

    print(f"Version check passed: {version}")
    return 0


def bump_version(version: str, dry_run: bool = False) -> int:
    if not validate_semver(version):
        print(f"Invalid semantic version: {version}", file=sys.stderr)
        return 1

    if dry_run:
        print(f"Would set version to {version} in:")
        for path in [APP_PACKAGE, SERVER_PYPROJECT, SERVER_VERSION_FILE, README]:
            print(f"  - {path.relative_to(ROOT)}")
        return 0

    write_app_version(version)
    write_server_pyproject_version(version)
    write_server_source_version(version)
    write_readme_badge_version(version)

    print(f"Updated version to {version}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Murmur version consistency.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser(
        "check", help="Check version consistency across files."
    )
    check_parser.add_argument(
        "--tag", help="Optional tag (e.g. v1.2.3) to validate against."
    )

    bump_parser = subparsers.add_parser(
        "bump", help="Update all managed files to a version."
    )
    bump_parser.add_argument("version", help="Semantic version to set (e.g. 1.2.3).")
    bump_parser.add_argument(
        "--dry-run", action="store_true", help="Show what would change."
    )

    args = parser.parse_args()

    if args.command == "check":
        return check_versions(expected_tag=args.tag)
    if args.command == "bump":
        return bump_version(args.version, dry_run=args.dry_run)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
