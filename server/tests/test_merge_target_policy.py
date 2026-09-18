from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts.merge_target_policy import is_trunk_integration_target, main


def test_push_to_trunk_is_an_allowed_integration_target() -> None:
    assert is_trunk_integration_target(
        event_name="push",
        base_ref="",
        ref_name="trunk",
    )


def test_pull_request_to_trunk_is_an_allowed_integration_target() -> None:
    assert is_trunk_integration_target(
        event_name="pull_request",
        base_ref="trunk",
        ref_name="feature/dictation-stack",
    )


def test_pull_request_to_feature_branch_is_rejected() -> None:
    assert not is_trunk_integration_target(
        event_name="pull_request",
        base_ref="feature/dictation-stack",
        ref_name="feature/model-runtime",
    )


def test_non_trunk_push_is_rejected() -> None:
    assert not is_trunk_integration_target(
        event_name="push",
        base_ref="",
        ref_name="feature/model-runtime",
    )


def test_unknown_event_is_rejected() -> None:
    assert not is_trunk_integration_target(
        event_name="workflow_dispatch",
        base_ref="trunk",
        ref_name="trunk",
    )


def test_runner_context_for_feature_target_fails_the_cli(monkeypatch) -> None:
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_BASE_REF", "feature/dictation-stack")
    monkeypatch.setenv("GITHUB_REF_NAME", "feature/model-runtime")

    assert main() == 1


def test_runner_context_for_trunk_pull_request_passes_the_cli(monkeypatch) -> None:
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_BASE_REF", "trunk")
    monkeypatch.setenv("GITHUB_REF_NAME", "feature/model-runtime")

    assert main() == 0


def test_ci_exposes_the_trunk_integration_target_check() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(
        encoding="utf-8"
    )

    assert "name: Trunk Integration Target" in workflow
    assert "run: python scripts/merge_target_policy.py" in workflow
