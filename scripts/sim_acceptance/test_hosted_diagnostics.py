"""Checks for safe hosted console diagnostics and smoke retry selection."""

import json
import os
import subprocess
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from websockets.exceptions import ConnectionClosedError

from scripts.sim_acceptance import hosted
from scripts.sim_acceptance.hosted import (
    FixtureUnavailable,
    fixture_reason,
    poll,
    smoke_delivery_issue,
)


class FixtureDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_poll_reports_the_named_fixture(self):
        with self.assertRaises(FixtureUnavailable) as caught:
            await poll(None, bool, 0, failure="cdp-http-unreachable")
        self.assertEqual(fixture_reason(caught.exception), "cdp-http-unreachable")

    def test_arbitrary_exception_text_is_not_exposed(self):
        self.assertEqual(fixture_reason(FixtureUnavailable("untrusted text")), "unspecified-fixture")
        self.assertEqual(fixture_reason(OSError("untrusted text")), "OSError")

    def test_smoke_distinguishes_pre_dispatch_skip_and_native_editor_failure(self):
        skipped = {
            "failed": True, "insert_matches_final": False, "delivery": "paste_skipped",
            "paste_helper_request_observed": False,
        }
        self.assertEqual(smoke_delivery_issue(skipped, True), "warmup-paste-skipped-before-helper")
        self.assertEqual(smoke_delivery_issue(skipped, False), "warmup-native-editor-control-unobserved")
        skipped["paste_helper_request_observed"] = True
        self.assertEqual(smoke_delivery_issue(skipped, True), "warmup-editor-insertion-unobserved")

    async def test_accuracy_uses_first_final_when_editor_and_later_final_differ(self):
        clip = {"id": "Q01", "mode": "quick", "sha256": "0" * 64, "duration_s": 0,
                "reference": "Alice Jones arrived", "entities": []}
        main = SimpleNamespace(eval=AsyncMock(return_value={
            "finals": ["Alice Jones arrived", "Wrong second final"],
            "editorDuringSpeech": 0, "delivery": None,
        }))
        editor = {"keys": [], "insertions": [1, 2], "text": "Alice Jones arrived twice",
                  "clipboard_restored": True, "clipboard_matches_final": False}
        desktop = SimpleNamespace(send=AsyncMock(side_effect=[None, 0, 1, editor]))
        with (patch.object(hosted, "history", AsyncMock(return_value={})),
              patch.object(hosted, "poll", AsyncMock()),
              patch.object(hosted.asyncio, "sleep", AsyncMock()),
              patch.object(hosted, "read_perf", return_value=[]),
              patch.object(hosted, "detect_paste_diagnostics", return_value={})):
            record, _ = await hosted.capture(main, SimpleNamespace(pid=os.getpid()), desktop,
                                             Path("trial.out.log"), clip, use_trace=False)
        self.assertEqual(record["word_errors"], 0)
        self.assertEqual(record["final_count"], 2)
        self.assertEqual(record["insertion_count"], 2)
        self.assertFalse(record["insert_matches_final"])

    async def test_runtime_warmup_error_requests_bundled_recovery(self):
        fallback = AsyncMock()
        result = await self.run_stub(RuntimeError("private diagnostic"), fallback=fallback)
        fallback.assert_awaited_once()
        self.assertEqual(result["app_fixture_gap"], "RuntimeError")

    async def test_app_close_reports_graceful_exit_and_forced_timeout(self):
        browser = SimpleNamespace(send=AsyncMock(), close=AsyncMock())
        for wait, expected in ((Mock(return_value=0), "graceful"),
                               (Mock(side_effect=subprocess.TimeoutExpired("app", 12)), "forced-after-timeout")):
            process = SimpleNamespace(poll=Mock(return_value=None), wait=wait)
            with patch.object(hosted, "stop_owned_tree") as force_stop:
                facts = await hosted.close_app(process, browser)
            self.assertEqual(facts, {"exit_path": expected, "close_request_sent": True})
            self.assertEqual(force_stop.call_count, int(expected == "forced-after-timeout"))

    async def test_measured_cdp_disconnect_records_gap_and_continues(self):
        recovered = {"id": "Q02", "output_observed": True}
        capture = AsyncMock(side_effect=[ConnectionClosedError(None, None), (recovered, {})])
        result = await self.run_stub(capture=capture)
        first, second = result["trials"]
        self.assertEqual(first["id"], "Q01")
        self.assertEqual(first["fixture_gap"], "cdp-connection-closed")
        self.assertFalse(first["output_observed"])
        self.assertNotIn("word_errors", first)
        self.assertEqual(second, recovered)

    async def run_stub(self, warmup_error=None, *, fallback=None, capture=None):
        @asynccontextmanager
        async def app_session(*args, **kwargs):
            yield (None, None, {"pid": 1}, None, None)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "scratch"
            root.mkdir()
            manifest = root / "manifest.json"
            manifest.write_text("{}", encoding="utf-8")
            args = SimpleNamespace(root=root, install=root / "install", manifest=manifest,
                                   config="far-quiet", smoke=False, entity_audit=None,
                                   output=root / "evidence.json")
            clips = [{"id": clip_id, "mode": "quick", "duration_s": 8,
                      "reference": "Alice arrived", "entities": [], "sha256": "0" * 64}
                     for clip_id in ("Q01", "Q02")]
            warmup = {"final_count": 1, "empty": False, "history_correct": True}
            editor_process = SimpleNamespace(returncode=0, wait=AsyncMock())
            with (patch.dict(os.environ, {"RUNNER_TEMP": temp, "GITHUB_SHA": "0" * 40,
                                          "GITHUB_RUN_ID": "123"}),
                  patch.object(hosted, "load_clips", return_value=clips),
                  patch.object(hosted.asyncio, "create_subprocess_exec",
                               AsyncMock(return_value=editor_process)),
                  patch.object(hosted, "observe_warmup",
                               AsyncMock(return_value=warmup, side_effect=warmup_error)),
                  patch.object(hosted, "hosted_replay", fallback or AsyncMock()),
                  patch.object(hosted, "app_session", app_session),
                  patch.object(hosted, "capture", capture or AsyncMock())):
                await hosted.run(args)
            return json.loads(args.output.read_text(encoding="utf-8"))
