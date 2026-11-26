"""Verify that corpus download retries discard corrupt completed partials."""

import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.sim_acceptance import prepare_corpus


class CorpusDownloadTests(unittest.TestCase):
    def test_invalid_completed_partial_is_discarded_before_retry(self):
        correct = b"verified archive"
        for result in ((0, "206"), (22, "416"), (33, "200")):
            with self.subTest(result=result), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                partial = root / "fixture.zip.part"
                partial.write_bytes(b"corrupt archive")
                pin = {"filename": "fixture.zip", "url": "https://example.invalid/fixture.zip",
                       "sha256": hashlib.sha256(correct).hexdigest()}

                completed = iter([subprocess.CompletedProcess([], result[0], stdout=result[1])])

                def simulated_download(args, *, partial=partial, completed=completed, **kwargs):
                    first = next(completed, None)
                    if first is not None:
                        return first
                    self.assertFalse(partial.exists())
                    partial.write_bytes(correct)
                    return subprocess.CompletedProcess(args, 0, stdout="200")

                with patch.object(prepare_corpus.subprocess, "run", side_effect=simulated_download) as download:
                    self.assertEqual(prepare_corpus.source_file(root, pin).read_bytes(), correct)
                self.assertEqual(download.call_count, 2)
