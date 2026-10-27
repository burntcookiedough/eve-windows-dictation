"""Exercise extracted lifecycle sequencing with synthetic files, never installers."""
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.name != 'nt', reason='Windows lifecycle harness')


@pytest.mark.parametrize('mode', ['success', 'existing-profile', 'existing-install', 'launch-failure'])
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
