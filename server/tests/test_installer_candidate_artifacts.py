"""Behavioral QA artifact/source controls; no packaging, install, app or model launch."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows QA artifact controls")
HEAD = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()


def run_ps(command, **values):
    env = dict(os.environ, HELPER=str(ROOT / "scripts/installer-candidate-artifacts.ps1"),
               MANIFEST=str(ROOT / "scripts/installer-manifest.ps1"))
    env.update({key: str(value) for key, value in values.items()})
    # Archive policy has its own production tests. These tests isolate orchestration
    # without requiring app/node_modules in the server-only CI job.
    setup = (
        "$ErrorActionPreference='Stop'; . $env:MANIFEST; . $env:HELPER; "
        "function Assert-SevenZipArchiveMethods { param($ArchivePath,$AppDir) }; "
        "function Get-CandidateRuntimeVersion { param($WinUnpackedDir) 'fixture-runtime' }; "
        "function node { 'fixture-node' }; function bun { 'fixture-bun' }; function uv { 'fixture-uv' }; "
    )
    return subprocess.run(["pwsh", "-NoProfile", "-Command", setup + command],
                          env=env, capture_output=True, text=True, timeout=30)


def unsigned_pe():
    # Remove the certificate directory from a standard Windows PE fixture; never run it.
    data = bytearray(Path(shutil.which("where.exe")).read_bytes())
    optional = struct.unpack_from("<I", data, 0x3C)[0] + 24
    directories = optional + (112 if struct.unpack_from("<H", data, optional)[0] == 0x20B else 96)
    struct.pack_into("<II", data, directories + 4 * 8, 0, 0)
    data[0x40] ^= 1  # Also break catalog identity; this fixture is never executed.
    return bytes(data)


@pytest.fixture
def staged(tmp_path):
    source, unpacked, retained = (tmp_path / name for name in ("source", "unpacked", "retained"))
    source.mkdir()
    unpacked.mkdir()
    (unpacked / "Eve.exe").write_bytes(b"fictional unpacked content")
    names = {
        "Eve.Web.Setup.0.8.2-alpha.8.exe": unsigned_pe(),
        "murmur-0.8.2-alpha.8-x64.nsis.7z": b"fixture payload",
    }
    for name, content in names.items():
        (source / name).write_bytes(content)
    wrapper, payload = names.values()
    latest = (
        "version: 0.8.2-alpha.8\nfiles:\n  - url: Eve.Web.Setup.0.8.2-alpha.8.exe\n"
        f"    sha512: {base64.b64encode(hashlib.sha512(wrapper).digest()).decode()}\n"
        "path: Eve.Web.Setup.0.8.2-alpha.8.exe\n"
        f"sha512: {base64.b64encode(hashlib.sha512(wrapper).digest()).decode()}\n"
        "releaseDate: '2026-10-28T00:00:00.000Z'\npackages:\n  x64:\n"
        "    file: murmur-0.8.2-alpha.8-x64.nsis.7z\n"
        "    path: murmur-0.8.2-alpha.8-x64.nsis.7z\n"
        f"    size: {len(payload)}\n"
        f"    sha512: {base64.b64encode(hashlib.sha512(payload).digest()).decode()}\n"
    )
    (source / "latest.yml").write_text(latest)
    notices = tmp_path / "notices.txt"
    notices.write_text("Generated from the exact pre-package closure\n")
    values = dict(SRC=source, UNPACKED=unpacked, NOTICES=notices, TARGET=retained, REPO=ROOT, COMMIT=HEAD)
    prepare = (
        "New-CandidateArtifactSet -SourceBuildDir $env:SRC -WinUnpackedDir $env:UNPACKED "
        "-LegalNoticesFile $env:NOTICES -TargetDir $env:TARGET -CandidateVersion '0.8.2-alpha.8' "
        "-ExpectedCommit $env:COMMIT -RepoRoot $env:REPO"
    )
    result = run_ps(prepare, **values)
    assert result.returncode == 0, result.stdout + result.stderr
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    for name in names:
        shutil.copyfile(retained / name, candidate / name)
    shutil.copyfile(retained / "qa/candidate-payload-manifest.json", candidate / "candidate-payload-manifest.json")
    return retained, candidate, prepare, values


def binding(retained, candidate):
    return run_ps(
        "Assert-CandidateBinding -CandidateInstaller $env:INSTALLER -CandidatePayload $env:PAYLOAD "
        "-RetainedDir $env:RETAINED -CandidateVersion '0.8.2-alpha.8' -RepoRoot $env:REPO",
        INSTALLER=candidate / "Eve.Web.Setup.0.8.2-alpha.8.exe",
        PAYLOAD=candidate / "murmur-0.8.2-alpha.8-x64.nsis.7z", RETAINED=retained, REPO=ROOT,
    )


def test_prepares_self_contained_verified_set(staged):
    retained, candidate, _, _ = staged
    assert len([p for p in retained.iterdir() if p.is_file()]) == 7
    provenance = json.loads((retained / "qa/candidate-provenance.json").read_text(encoding="utf-8-sig"))
    assert provenance["commit"] == HEAD
    assert provenance["tools"]["bundledPython"] == "fixture-runtime"
    assert provenance["payloadManifestSha256"] == hashlib.sha256(
        (candidate / "candidate-payload-manifest.json").read_bytes()).hexdigest()
    assert binding(retained, candidate).returncode == 0


@pytest.mark.parametrize("target", ["installer", "payload", "qa-manifest", "retained-qa", "retained-manifest", "source"])
def test_rejects_changed_candidate_evidence(staged, target):
    retained, candidate, _, _ = staged
    assert binding(retained, candidate).returncode == 0
    paths = {
        "installer": candidate / "Eve.Web.Setup.0.8.2-alpha.8.exe",
        "payload": candidate / "murmur-0.8.2-alpha.8-x64.nsis.7z",
        "qa-manifest": candidate / "candidate-payload-manifest.json",
        "retained-qa": retained / "qa/candidate-payload-manifest.json",
        "retained-manifest": retained / "eve-v0.8.2-alpha.8-artifact-manifest.json",
    }
    if target == "source":
        path = retained / "qa/candidate-provenance.json"
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        data["commit"] = "a" * 40
        path.write_text(json.dumps(data))
    else:
        paths[target].write_bytes(b"changed evidence")
    assert binding(retained, candidate).returncode != 0


def test_preserves_colliding_evidence(staged):
    retained, _, prepare, values = staged
    before = (retained / "qa/candidate-provenance.json").read_bytes()
    result = run_ps(prepare, **values)
    assert result.returncode != 0
    assert (retained / "qa/candidate-provenance.json").read_bytes() == before


@pytest.mark.parametrize("commit,repo", [("INVALID", ROOT), (HEAD.upper(), ROOT), ("a" * 40, ROOT), (HEAD, ROOT / "not-a-repository")])
def test_source_guard_fails_closed(commit, repo):
    result = run_ps("Assert-ExpectedCommit -Commit $env:COMMIT -RepoRoot $env:REPO", COMMIT=commit, REPO=repo)
    assert result.returncode != 0


def test_phase_failure_stays_failed_and_redacts_paths(staged):
    retained, _, _, _ = staged
    result = run_ps(
        "Set-CandidatePhaseStatus -RetainedDir $env:TARGET -PhaseName 'candidate_upgrade' -Status 'started'; "
        "Set-CandidatePhaseStatus -RetainedDir $env:TARGET -PhaseName 'overall' -Status 'failed' -ErrorDetail 'C:\\Users\\qa-fixture\\failure'; "
        "Set-CandidatePhaseStatus -RetainedDir $env:TARGET -PhaseName 'cleanup' -Status 'passed'; "
        "Set-CandidatePhaseStatus -RetainedDir $env:TARGET -PhaseName 'overall' -Status 'failed' -ErrorDetail 'Lifecycle step failed'; "
        "Set-CandidatePhaseStatus -RetainedDir $env:TARGET -PhaseName 'overall' -Status 'passed'", TARGET=retained,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads((retained / "qa/candidate-phase-status.json").read_text(encoding="utf-8-sig"))
    assert data["overallStatus"] == "failed"
    assert data["phases"]["overall"]["status"] == "failed"
    assert data["phases"]["overall"]["error"] == "<user-home>\\failure"
    assert data["phases"]["candidate_upgrade"]["status"] == "failed"
    assert data["phases"]["candidate_upgrade"]["error"] == "<user-home>\\failure"
    assert data["phases"]["cleanup"]["status"] == "passed"
    assert data["disclaimers"]["functionalHistoryProof"] is False


def test_workflow_upload_allowlist_excludes_other_qa_files(staged):
    retained, _, _, _ = staged
    (retained / "qa/not-for-upload.txt").write_text("fictional canary")
    workflow = (ROOT / ".github/workflows/installer-lifecycle-ci.yml").read_text()
    upload = workflow.split("- name: Upload candidate QA artifacts", 1)[1]
    block = upload.split("path: |\n", 1)[1].split("retention-days", 1)[0]
    entries = [line.strip() for line in block.splitlines() if line.strip()]
    prefix = "${{ runner.temp }}/eve-alpha8-candidate-artifacts-${{ github.run_id }}/"
    assert len(entries) == 10
    assert all(entry.startswith(prefix) for entry in entries)
    patterns = [entry[len(prefix):] for entry in entries]
    selected = {path.relative_to(retained).as_posix() for pattern in patterns for path in retained.glob(pattern.strip())}
    generated = {path.relative_to(retained).as_posix() for path in retained.rglob("*") if path.is_file()}
    assert len(selected) == 10
    assert selected == generated - {"qa/not-for-upload.txt"}


def test_binding_defaults_match_lifecycle_scope(staged):
    retained, candidate, _, _ = staged
    command = (
        "$script:candidateInstaller=$env:INSTALLER; $script:candidatePayload=$env:PAYLOAD; "
        "$script:RetainedArtifactDir=$env:RETAINED; $script:CandidateVersion='0.8.2-alpha.8'; "
        "Assert-CandidateBinding"
    )
    values = dict(INSTALLER=candidate / "Eve.Web.Setup.0.8.2-alpha.8.exe",
                  PAYLOAD=candidate / "murmur-0.8.2-alpha.8-x64.nsis.7z", RETAINED=retained)
    result = run_ps(command, **values)
    assert result.returncode == 0, result.stderr
    (candidate / "candidate-payload-manifest.json").write_text("changed QA evidence")
    assert run_ps(command, **values).returncode != 0


def test_named_failure_can_record_first_detailed_overall(staged):
    retained, _, _, _ = staged
    result = run_ps(
        "Set-CandidatePhaseStatus -RetainedDir $env:TARGET -PhaseName 'cleanup' -Status 'failed'; "
        "Set-CandidatePhaseStatus -RetainedDir $env:TARGET -PhaseName 'overall' -Status 'failed' -ErrorDetail 'Owned cleanup exception'",
        TARGET=retained,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads((retained / "qa/candidate-phase-status.json").read_text(encoding="utf-8-sig"))
    assert data["phases"]["overall"]["error"] == "Owned cleanup exception"


def test_workflow_builder_uses_typed_unsigned_and_publish_never():
    workflow = (ROOT / ".github/workflows/installer-lifecycle-ci.yml").read_text()
    build = workflow.split("- name: Build candidate Windows web installer", 1)[1].split("- name: Run isolated", 1)[0]
    code = re.search(r'node -e "(.+)"', build).group(1)
    # Evaluate the actual workflow JS with a builder stub, never package an app.
    driver = """
const vm=require('node:vm'),assert=require('node:assert/strict');let calls=0;
vm.runInNewContext(process.env.QA_BUILD_CODE,{require:name=>{assert.equal(name,'electron-builder');return {build:o=>{
assert.equal(o.publish,'never');assert.equal(o.config.win.signExecutable,false);
assert.equal(o.win.length,1);assert.equal(o.win[0],'nsis-web');calls++;return Promise.resolve();}}},console,process});
assert.equal(calls,1);console.log('UNSIGNED_PUBLISH_NEVER');
"""
    result = subprocess.run(["node", "-e", driver], env=dict(os.environ, QA_BUILD_CODE=code),
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert "UNSIGNED_PUBLISH_NEVER" in result.stdout


@pytest.mark.parametrize("expected,event_sha,ref,passes", [
    (HEAD, HEAD, "refs/heads/trunk", True),
    ("a" * 40, HEAD, "refs/heads/trunk", False),
    (HEAD.upper(), HEAD, "refs/heads/trunk", False),
    (HEAD, "a" * 40, "refs/heads/trunk", False),
    (HEAD, HEAD, "refs/heads/unapproved", False),
    ("", HEAD, "refs/heads/trunk", False),
])
def test_real_workflow_preflight_before_build(expected, event_sha, ref, passes):
    workflow = (ROOT / ".github/workflows/installer-lifecycle-ci.yml").read_text()
    block = workflow.split("- name: Require the dedicated candidate or trunk workflow context", 1)[1].split("- name: Set up uv", 1)[0]
    command = block.split("run: |\n", 1)[1]
    command = "\n".join(line[10:] for line in command.splitlines())
    # Only the extracted preflight executes against synthetic event metadata, never
    # the hosted lifecycle entrypoint, package steps or upload.
    env = dict(os.environ, GITHUB_ACTIONS="true", RUNNER_ENVIRONMENT="github-hosted", OS="Windows_NT",
               GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF=ref, GITHUB_SHA=event_sha, EXPECTED_COMMIT=expected)
    result = subprocess.run(["pwsh", "-NoProfile", "-Command", command], cwd=ROOT, env=env,
                            capture_output=True, text=True, timeout=15)
    assert (result.returncode == 0) == passes, result.stderr
