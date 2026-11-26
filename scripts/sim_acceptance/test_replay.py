"""Synthetic coverage and transport regressions for replay without a server."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import psutil

from scripts.sim_acceptance import replay


class ReplayTests(unittest.IsolatedAsyncioTestCase):
    async def test_warmup_timeout_still_attempts_each_clip(self):
        clips = [{"id": clip_id, "mode": "quick", "duration_s": 8,
                  "reference": "Alice arrived", "entities": [], "sha256": "0" * 64}
                 for clip_id in ("Q01", "Q02")]
        completed = {"outcome": "success", "text": "Alice arrived", "stop_to_final_text_ms": 12}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "evidence.json"
            with (patch.object(replay, "replay_trial",
                               AsyncMock(side_effect=[TimeoutError(), TimeoutError(), completed])),
                  patch.object(replay.asyncio, "sleep", AsyncMock())):
                await replay.run_replay(123, os.getpid(), clips, {"resources": {}, "trials": []}, path)
            snapshot = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(snapshot["warmup_fixture_gap"], "TimeoutError")
        first, second = snapshot["trials"]
        self.assertFalse(first["output_observed"])
        self.assertNotIn("word_errors", first)
        self.assertEqual(second["word_errors"], 0)

    def test_long_sampling_requires_continuous_window_and_no_sampler_errors(self):
        samples = replay.ProcessSamples(os.getpid())
        samples.samples = [(float(second), replay.GIB, {}) for second in range(1802)]
        self.assertTrue(samples.long(0, 1800, 1801)["long_rss_window_covered"])
        samples.samples = [row for row in samples.samples if not 600 < row[0] < 630]
        self.assertFalse(samples.long(0, 1800, 1801)["long_rss_window_covered"])
        with patch.object(samples.root, "children", side_effect=psutil.AccessDenied):
            samples.sample()
        self.assertEqual(samples.long(0, 1800, 1801)["long_sample_errors"], 1)
