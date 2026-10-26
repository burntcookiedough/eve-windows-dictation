"""Run only actual smoke cleanup/functions, never its installer/profile actions."""
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / 'fixtures'
pytestmark = pytest.mark.skipif(os.name != 'nt', reason='Windows process/CIM semantics')


@pytest.mark.parametrize('mode', [
    'success', 'failure', 'forced', 'missing-pid', 'nested',
    'wrong-path', 'wrong-parent', 'wrong-birth', 'preflight', 'provider-paths',
    'fast-launcher', 'exit-during-inspection',
])
def test_smoke_cleanup_owns_only_its_processes(tmp_path, mode):
    isolated = tmp_path / 'fixture with spaces'
    isolated.mkdir()
    result = subprocess.run(
        ['pwsh', '-NoProfile', '-File', str(FIXTURES / 'installer-smoke-cleanup.ps1'),
         '-SmokeScript', str(ROOT / 'scripts/installer-smoke.ps1'),
         '-PythonExe', sys._base_executable,
         '-BackendScript', str(FIXTURES / 'smoke_backend_probe.py'),
         '-Root', str(isolated), '-Mode', mode],
        capture_output=True, text=True, timeout=35,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    marker = ('PROVIDER_PROOF=' if mode == 'provider-paths' else
              'PREFLIGHT_PROOF=' if mode == 'preflight' else
              'REFUSAL_PROOF=' if mode.startswith('wrong-') else 'CLEANUP_PROOF=')
    assert marker in result.stdout
