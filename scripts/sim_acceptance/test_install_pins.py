"""Bind the hosted installer parameters without running the installer body."""

import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


INSTALL_SCRIPT = Path(__file__).with_name("install.ps1").resolve()
PWSH = shutil.which("pwsh")
NEW_PINS = {
    "RunId": "45880000001",
    "ArtifactId": "15110000002",
    "Commit": "ab" * 20,
    "ManifestSha256": "CD" * 32,
}

BIND_PINS = r"""
$ErrorActionPreference = 'Stop'
$tree = [System.Management.Automation.Language.Parser]::ParseFile($env:EVE_TEST_INSTALL_SCRIPT, [ref]$null, [ref]$null)
$bind = [ScriptBlock]::Create($tree.ParamBlock.Extent.Text + "`n" + 'ConvertTo-Json -InputObject $PSBoundParameters -Compress')
$pins = ConvertFrom-Json -InputObject $env:EVE_TEST_INSTALL_PINS -AsHashtable
try { & $bind @pins }
catch [System.Management.Automation.ParameterBindingException] { exit 2 }
"""


@unittest.skipUnless(PWSH, "PowerShell 7 is required to exercise hosted parameter binding")
class InstallerPinTests(unittest.TestCase):
    def bind(self, pins):
        return subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-EncodedCommand",
             base64.b64encode(BIND_PINS.encode("utf-16-le")).decode("ascii")],
            env={**os.environ, "EVE_TEST_INSTALL_SCRIPT": str(INSTALL_SCRIPT),
                 "EVE_TEST_INSTALL_PINS": json.dumps(pins)},
            capture_output=True, text=True, encoding="utf-8", timeout=15,
        )

    def test_accepts_new_candidate_pins(self):
        result = self.bind(NEW_PINS)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), NEW_PINS)

    def test_rejects_empty_or_malformed_ids(self):
        for field, value in (("RunId", ""), ("RunId", "0"), ("RunId", "123\n"),
                             ("ArtifactId", "0123"), ("ArtifactId", "123.0")):
            with self.subTest(field=field, value=value):
                result = self.bind({**NEW_PINS, field: value})
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_rejects_wrong_length_or_non_hex_digests(self):
        for field, value in (("Commit", "a" * 39), ("Commit", "g" * 40),
                             ("ManifestSha256", "a" * 63), ("ManifestSha256", "a" * 64 + "\n")):
            with self.subTest(field=field, value=value):
                result = self.bind({**NEW_PINS, field: value})
                self.assertEqual(result.returncode, 2, result.stderr)
