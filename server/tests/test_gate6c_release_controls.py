"""Static guards for the no-rebuild Gate 6C release promotion path."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_release_workflow_is_manual_and_never_builds_or_uploads() -> None:
    workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    assert "workflow_dispatch:" in workflow
    assert "push:" not in workflow
    for forbidden in ("package:win", "electron-builder", "bun install", "softprops/action-gh-release", "gh release upload", "gh release create"):
        assert forbidden not in workflow
    assert "production-release" in workflow
    assert "allow_unsigned" in workflow
    assert "accepted_name_risk" in workflow
    assert "default: false" in workflow
    assert "draft=false" in workflow


def test_release_asset_contract_and_notice_generator_are_tracked() -> None:
    artifacts = (ROOT / "scripts/release-artifacts.ps1").read_text(encoding="utf-8")
    notices = (ROOT / "scripts/generate-third-party-notices.ps1").read_text(encoding="utf-8")
    for name in ("Eve.Web.Setup.$version.exe", "murmur-$version-x64.nsis.7z", "latest.yml", "SHA256SUMS.txt", "SHA512SUMS.txt", "THIRD_PARTY_NOTICES.txt"):
        assert name in artifacts
    assert "2100000000" in artifacts
    assert "NotSigned" in artifacts
    assert "Unclassified shipped component" in notices
    assert "THIRD_PARTY_INVENTORY.json" in notices
    assert "Get-ChildItem $dist.FullName -Recurse -File" in notices
    assert "the mit license" in notices.lower()
    assert "$Matches[1].Trim()" in notices
    assert "ToLowerInvariant" in notices
    assert "unknown|none|n/?a" in notices
    assert "$isBsd3" in notices
    assert "neither the name.*endorse or promote" in notices
