"""Exercise extracted lifecycle sequencing with synthetic files, never installers."""
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.name != 'nt', reason='Windows lifecycle harness')


@pytest.mark.parametrize('mode', [
    'success', 'existing-profile', 'existing-install', 'launch-failure',
    'earlier-profile-removed', 'earlier-profile-changed',
    'cleanup-failure',
])
def test_candidate_clean_install_is_isolated_and_fail_closed(tmp_path, mode):
    result = subprocess.run(
        ['pwsh', '-NoProfile', '-File',
         str(Path(__file__).parent / 'fixtures/installer-lifecycle-sequence.ps1'),
         '-LifecycleScript', str(ROOT / 'scripts/installer-lifecycle-ci.ps1'),
         '-Root', str(tmp_path), '-Mode', mode],
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert f'SEQUENCE_PROOF={mode}' in result.stdout


@pytest.mark.parametrize('mode', ['existing-profile', 'existing-install'])
def test_collision_proof_rejects_an_unrelated_failure(tmp_path, mode):
    source = (ROOT / 'scripts/installer-lifecycle-ci.ps1').read_text(encoding='utf-8')
    phase = "Write-Step 'Installing alpha.8 into a fresh installation and synthetic profile.'"
    assert source.count(phase) == 1
    mutated = tmp_path / 'lifecycle.ps1'
    mutated.write_text(source.replace(phase, "throw 'Synthetic unrelated phase failure.'"), encoding='utf-8')
    result = subprocess.run(
        ['pwsh', '-NoProfile', '-File',
         str(Path(__file__).parent / 'fixtures/installer-lifecycle-sequence.ps1'),
         '-LifecycleScript', str(mutated), '-Root', str(tmp_path / 'owned'), '-Mode', mode],
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode != 0, 'An unrelated failure was accepted as collision proof.'
    assert 'Expected collision rejection' in result.stderr
