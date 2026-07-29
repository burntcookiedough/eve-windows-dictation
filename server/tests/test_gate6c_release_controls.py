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
    allow_block = workflow.split("allow_unsigned:", 1)[1].split("accepted_name_risk:", 1)[0]
    name_block = workflow.split("accepted_name_risk:", 1)[1].split("permissions:", 1)[0]
    assert "default: false" in allow_block
    assert "default: false" in name_block
    assert "draft=false" in workflow


def test_release_asset_contract_and_notice_generator_are_tracked() -> None:
    artifacts = (ROOT / "scripts/release-artifacts.ps1").read_text(encoding="utf-8")
    notices = (ROOT / "scripts/generate-third-party-notices.ps1").read_text(encoding="utf-8")
    for name in ("Eve.Web.Setup.$version.exe", "murmur-$version-x64.nsis.7z", "latest.yml", "SHA256SUMS.txt", "SHA512SUMS.txt", "THIRD_PARTY_NOTICES.txt"):
        assert name in artifacts
    assert "2100000000" in artifacts
    assert "NotSigned" in artifacts
    assert "Authenticode must be Valid when allow_unsigned=false" in artifacts
    assert "Manifest schema, format, tag, commit, or version mismatch." in artifacts
    assert 'checksum does not match manifest.' in artifacts
    assert "Missing required latest.yml fields." in artifacts
    assert "Unknown or malformed latest.yml line" in artifacts
    assert "latest.yml hash or size mismatch." in artifacts
    assert "Unclassified shipped component" in notices
    assert "THIRD_PARTY_INVENTORY.json" in notices
    assert "Get-ChildItem $dist.FullName -Recurse -File" in notices
    assert "the mit license" in notices.lower()
    assert "$Matches[1].Trim()" in notices
    assert "ToLowerInvariant" in notices
    assert "unknown|none|n/?a" in notices
    assert "$isBsd3" in notices
    assert "neither the name.*endorse or promote" in notices
    assert "Reviewed override SHA-256 mismatch" in notices
    assert "Get-StableSource" in notices
    assert "Packaged native DLL inventory is empty." in notices
    assert "Configured native notice absent from packaged DLL inventory" in notices


def test_release_workflow_maps_inputs_and_preserves_release_boundaries() -> None:
    workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    assert "persist-credentials: false" in workflow
    assert "targetCommitish -ne $env:EXPECTED_COMMIT" in workflow
    assert "EXPECTED_MANIFEST_SHA256" in workflow
    assert "-AllowUnsigned:($env:ALLOW_UNSIGNED -eq 'true')" in workflow
    assert "gh release edit $env:TAG" in workflow
    assert "gh release upload" not in workflow
    assert "gh release create" not in workflow


def test_packaged_resource_and_runtime_harness_guards() -> None:
    package = (ROOT / "app/package.json").read_text(encoding="utf-8")
    verify = (ROOT / "scripts/release-verify.ps1").read_text(encoding="utf-8")
    assert '"package": "bun run notices:generate && bun run build && electron-builder"' in package
    assert '"to": "legal"' in package
    assert ".runtime\\python.exe" in verify
    assert "import faster_whisper, torch, nemo.collections.asr" in verify
    assert 'Remove-Item -Path "env:$key"' in verify
