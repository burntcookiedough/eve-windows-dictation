"""Synthetic coverage and transport regressions for replay without a server."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import psutil
from websockets.exceptions import ConnectionClosedError

from scripts.sim_acceptance import replay


class ReplayTests(unittest.IsolatedAsyncioTestCase):
    async def test_warmup_timeout_still_attempts_each_clip(self):
        clips = [{"id": clip_id, "mode": "quick", "duration_s": 8,
                  "reference": "Alice arrived", "entities": [], "sha256": "0" * 64}
                 for clip_id in ("Q01", "Q02")]
        completed = {"outcome": "success", "text": "Alice arrived", "stop_to_final_text_ms": 12}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "evidence.json"
            observations = AsyncMock(side_effect=[TimeoutError(), TimeoutError(), completed])
            with (patch.object(replay, "replay_trial", observations),
                  patch.object(replay, "has_loopback_listener", return_value=True),
                  patch.object(replay.asyncio, "sleep", AsyncMock())):
                await replay.run_replay(123, psutil.Process(), clips, {"resources": {}, "trials": []}, path)
            snapshot = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(snapshot["warmup_fixture_gap"], "TimeoutError")
        first, second = snapshot["trials"]
        self.assertFalse(first["output_observed"])
        self.assertNotIn("word_errors", first)
        self.assertEqual(second["word_errors"], 0)
        self.assertTrue(all(call.kwargs["connect"].keywords == {"proxy": None}
                            for call in observations.await_args_list))

    async def test_warmup_disconnect_with_no_owned_listener_leaves_clips_unattempted(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "evidence.json"
            observations = AsyncMock(side_effect=ConnectionClosedError(None, None))
            with (patch.object(replay, "replay_trial", observations),
                  patch.object(replay, "has_loopback_listener", return_value=False)):
                await replay.run_replay(123, psutil.Process(), [{}], {"resources": {}, "trials": []}, path)
            snapshot = json.loads(path.read_text(encoding="utf-8"))
        observations.assert_awaited_once()
        self.assertFalse(snapshot["warmup_ok"])
        self.assertEqual(snapshot["replay_stopped_reason"], "owned-listener-unavailable-after-warmup")
        self.assertEqual(snapshot["trials"], [])

    async def test_server_exit_keeps_long_attempt_and_sampler_gap(self):
        clip = {"id": "L01", "mode": "long", "duration_s": 1800,
                "reference": "Alice arrived", "entities": [], "sha256": "0" * 64}
        ready = {"outcome": "success", "text": "Alice arrived"}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "evidence.json"
            owned = psutil.Process()
            with (patch.object(replay, "replay_trial",
                               AsyncMock(side_effect=[ready, ConnectionClosedError(None, None)])),
                  patch.object(replay, "idle_resources", AsyncMock(return_value={})),
                  patch.object(owned, "is_running", return_value=False)):
                await replay.run_replay(123, owned, [clip], {"resources": {}, "trials": []}, path)
            snapshot = json.loads(path.read_text(encoding="utf-8"))
        trial, = snapshot["trials"]
        self.assertEqual(trial["id"], "L01")
        self.assertEqual(trial["fixture_gap"], "ConnectionClosedError")
        self.assertGreater(snapshot["resources"]["long_sample_errors"], 0)
        self.assertFalse(snapshot["resources"]["long_rss_window_covered"])

    async def test_long_replay_passes_observed_boundaries_to_sampler(self):
        clip = {"id": "L01", "mode": "long", "duration_s": 1800,
                "reference": "Alice arrived", "entities": [], "sha256": "0" * 64}
        final = {"outcome": "success", "text": "Alice arrived", "stop_to_final_text_ms": 500,
                 "stream_started_at": 12, "stop_requested_at": 1812, "final_received_at": 1812.5}
        samples = replay.ProcessSamples(os.getpid())
        with (tempfile.TemporaryDirectory() as temp,
              patch.object(replay, "replay_trial", AsyncMock(return_value=final)),
              patch.object(replay, "idle_resources", AsyncMock(return_value={})),
              patch.object(replay, "ProcessSamples", return_value=samples),
              patch.object(samples, "long", return_value={}) as summary):
            await replay.run_replay(123, psutil.Process(), [clip], {"resources": {}, "trials": []},
                                    Path(temp) / "evidence.json")
        summary.assert_called_once_with(12, 1812, 1812.5)

    async def test_gpu_rechecks_same_owned_process_after_readiness(self):
        owned = Mock()
        with (patch.object(replay, "gpu_owner", return_value=({"port": 123}, owned)),
              patch.object(replay, "wait_health", AsyncMock(return_value={"runtime": {}})),
              patch.object(replay, "has_loopback_listener", return_value=False) as verify,
              self.assertRaisesRegex(ValueError, "no longer owns")):
            await replay.run_gpu(None)
        verify.assert_called_once_with(owned, 123)

    def test_validates_loopback_listener_on_specific_port(self):
        def listener(ip, port):
            return SimpleNamespace(status=psutil.CONN_LISTEN, laddr=SimpleNamespace(ip=ip, port=port))

        process = Mock()
        process.net_connections.return_value = [listener("127.0.0.1", 123), listener("0.0.0.0", 456)]
        self.assertTrue(replay.has_loopback_listener(process, 123))
        self.assertFalse(replay.has_loopback_listener(process, 456))
        self.assertFalse(replay.has_loopback_listener(process, 789))

    def test_long_sampling_requires_continuous_window_and_no_sampler_errors(self):
        samples = replay.ProcessSamples(os.getpid())
        samples.samples = [(float(second), replay.GIB, {}) for second in range(1802)]
        samples.samples.append((1803, 3 * replay.GIB, {}))
        covered = samples.long(0, 1800, 1801)
        self.assertTrue(covered["long_rss_window_covered"])
        self.assertEqual(covered["long_peak_rss_gib"], 1)
        samples.samples = [row for row in samples.samples if not 600 < row[0] < 630]
        self.assertFalse(samples.long(0, 1800, 1801)["long_rss_window_covered"])
        with patch.object(samples.root, "children", side_effect=psutil.AccessDenied):
            samples.sample()
        self.assertEqual(samples.long(0, 1800, 1801)["long_sample_errors"], 1)
