"""Enforce that CI integration checks run against the canonical trunk branch."""

from __future__ import annotations

import os
import sys


TRUNK_BRANCH = "trunk"


def is_trunk_integration_target(
    *,
    event_name: str,
    base_ref: str | None,
    ref_name: str | None,
) -> bool:
    """Return whether a GitHub event targets the canonical integration branch."""

    if event_name == "pull_request":
        return base_ref == TRUNK_BRANCH
    if event_name == "push":
        return ref_name == TRUNK_BRANCH
    return False


def main() -> int:
    """Check the GitHub event context supplied through the runner environment."""

    if is_trunk_integration_target(
        event_name=os.environ.get("GITHUB_EVENT_NAME", ""),
        base_ref=os.environ.get("GITHUB_BASE_REF", ""),
        ref_name=os.environ.get("GITHUB_REF_NAME", ""),
    ):
        print("Merge target check passed: integration runs are on trunk.")
        return 0

    print(
        "Merge target check failed: pull requests must target trunk and pushes "
        "must run on trunk.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
