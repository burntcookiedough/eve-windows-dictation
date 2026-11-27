"""Synthetic coverage and transport regressions for replay without a server."""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from contextlib import contextmanager
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import psutil
from websockets.exceptions import ConnectionClosedError

from scripts.sim_acceptance import replay, score
from scripts.sim_acceptance.owned_process import launch_owned_process


NEW_CANDIDATE = {"run_id": "45880000001", "artifact_id": "15110000002",
                 "commit": "ab" * 20, "manifest_sha256": "cd" * 32}


class ReplayTests(unittest.IsolatedAsyncioTestCase):
    def test_replay_cli_selects_explicit_or_legacy_candidate(self):
        argv = ["replay.py", "--source", "candidate", "--manifest", "manifest.json", "--output", "evidence.json"]
        pins = [NEW_CANDIDATE["run_id"], NEW_CANDIDATE["artifact_id"],
                NEW_CANDIDATE["commit"].upper(), NEW_CANDIDATE["manifest_sha256"].upper()]
        for options, candidate in ((["--pid-file", "server.pid"], None), (["--candidate", *pins], NEW_CANDIDATE)):
            with (self.subTest(candidate=candidate), patch("sys.argv", argv + options),
                  patch.object(replay, "run_gpu", AsyncMock()) as run):
                replay.main()
                self.assertEqual(run.await_args.kwargs["candidate"], candidate)
        with (patch("sys.argv", argv + ["--pid-file", "foreign.pid", "--candidate", *pins]),
              patch.object(replay, "run_gpu", AsyncMock()) as run,
              self.assertRaises(SystemExit)):
            replay.main()
        run.assert_not_awaited()

    async def test_candidate_stamp_requires_a_live_launched_child(self):
        for scenario in ("completed", "foreign PID", "child exit"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                args = SimpleNamespace(source=root / "candidate", pid_file=None, manifest=root / "manifest.json",
                                       output=root / "evidence.json", entity_audit=root / "audit.json")
                server = args.source / "server"
                python = server / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
                python.parent.mkdir(parents=True)
                python.touch()
                entry_point = server / "src/main.py"
                entry_point.parent.mkdir()
                entry_point.touch()
                launcher = Mock(pid=123)
                launcher.poll.return_value = None
                process = Mock(pid=124)
                process.is_running.return_value = True
                launcher.children.return_value = [process]

                closed = Mock()

                @contextmanager
                def launch(command, *, cwd, env, **_options):
                    self.assertEqual(command, [str(python), "-B", str(entry_point)])
                    self.assertEqual(cwd, server)
                    self.assertEqual((env["MURMUR_HOST"], env["MURMUR_PORT"]), ("127.0.0.1", "0"))
                    pid_file = Path(env["MURMUR_PID_FILE"])
                    self.assertFalse(pid_file.exists())
                    pid = 456 if scenario == "foreign PID" else process.pid
                    pid_file.write_text(json.dumps({"pid": pid, "port": 789}), encoding="utf-8")
                    try:
                        yield launcher
                    finally:
                        closed()

                async def replay_clips(port, owned, clips, result, path, audit):
                    self.assertEqual(port, 789)
                    self.assertIs(owned, process)
                    self.assertEqual(result["candidate"], NEW_CANDIDATE)
                    self.assertNotEqual(path, args.output)
                    score.write_evidence(audit.path, audit.snapshot)
                    if scenario == "child exit":
                        process.is_running.return_value = False
                        await asyncio.Future()

                with (patch.object(replay.subprocess, "check_output",
                                   side_effect=[str(args.source), NEW_CANDIDATE["commit"], "",
                                                "NVIDIA GeForce RTX 3060 Laptop GPU"]),
                      patch.object(replay, "launch_owned_process", side_effect=launch) as start,
                      patch.object(replay, "has_loopback_listener", return_value=True) as listener,
                      patch.object(replay, "wait_health", AsyncMock(return_value={"runtime": {}})),
                      patch.object(replay, "load_clips", return_value=[]),
                      patch.object(replay, "run_replay", AsyncMock(side_effect=replay_clips)) as run):
                    if scenario == "foreign PID":
                        with self.assertRaisesRegex(ValueError, "does not own"):
                            await replay.run_gpu(args, candidate=NEW_CANDIDATE)
                        listener.assert_not_called()
                        run.assert_not_awaited()
                    elif scenario == "child exit":
                        with self.assertRaisesRegex(RuntimeError, "exited during replay"):
                            await asyncio.wait_for(replay.run_gpu(args, candidate=NEW_CANDIDATE), timeout=3)
                        run.assert_awaited_once()
                    else:
                        await replay.run_gpu(args, candidate=NEW_CANDIDATE)
                        evidence = json.loads(args.output.read_text(encoding="utf-8"))
                        audit = json.loads(args.entity_audit.read_text(encoding="utf-8"))
                        self.assertEqual(evidence["candidate"], NEW_CANDIDATE)
                        self.assertEqual(audit["candidate"], NEW_CANDIDATE)
                        report, _ = score.render([evidence], None, None, expected_candidate=NEW_CANDIDATE)
                        self.assertIn(NEW_CANDIDATE["commit"], report)
                    start.assert_called_once()
                    closed.assert_called_once()
                if scenario != "completed":
                    self.assertFalse(args.output.exists())
                    self.assertFalse(args.entity_audit.exists())

    def test_gpu_owner_rejects_mismatched_or_dirty_candidate_source(self):
        args = SimpleNamespace(source=Path("candidate"))
        for head, status in ((NEW_CANDIDATE["commit"], ""), (score.CANDIDATE["commit"], " M source.py")):
            with (self.subTest(head=head, dirty=bool(status)),
                  patch.object(replay.subprocess, "check_output", side_effect=[str(args.source.resolve()), head, status]),
                  self.assertRaisesRegex(ValueError, "clean verified candidate source commit")):
                replay.gpu_owner(args)

    def test_candidate_git_checks_ignore_inherited_foreign_repository(self):
        env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}

        def checkout(root, text):
            root.mkdir()
            (root / "main.py").write_text(text, encoding="utf-8")
            def git(*args):
                return subprocess.check_output(["git", "-C", root, *args], env=env, text=True).strip()
            git("init", "--quiet")
            git("add", "main.py")
            git("-c", "user.name=Replay fixture", "-c", "user.email=fixture@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture")
            return git("rev-parse", "HEAD")

        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "candidate"
            foreign = Path(temp) / "foreign"
            expected = checkout(source, "# candidate\n")
            other = checkout(foreign, "# other\n")
            with patch.dict(os.environ, {"GIT_DIR": str(foreign / ".git"), "GIT_WORK_TREE": str(foreign)}):
                replay.verify_candidate_source(source, expected)
                with self.assertRaisesRegex(ValueError, "clean verified candidate source commit"):
                    replay.verify_candidate_source(source, other)
                (source / "main.py").write_text("# changed\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "clean verified candidate source commit"):
                    replay.verify_candidate_source(source, expected)

    def test_candidate_source_rejects_an_ignored_nested_server_copy(self):
        env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)

            def git(*args):
                return subprocess.check_output(["git", "-C", source, *args], env=env, text=True).strip()

            git("init", "--quiet")
            (source / ".gitignore").write_text("nested/\n", encoding="utf-8")
            git("add", ".gitignore")
            git("-c", "user.name=Replay fixture", "-c", "user.email=fixture@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture")
            nested = source / "nested"
            entry_point = nested / "server/src/main.py"
            entry_point.parent.mkdir(parents=True)
            entry_point.write_text("# ignored server copy\n", encoding="utf-8")
            self.assertEqual(git("status", "--porcelain"), "")
            commit = git("rev-parse", "HEAD")
            replay.verify_candidate_source(source, commit)
            with self.assertRaisesRegex(ValueError, "candidate Git worktree root"):
                replay.verify_candidate_source(nested, commit)

    def test_owned_process_cleanup_stops_child_after_launcher_exits(self):
        command = [sys.executable, "-c",
                   "import subprocess, sys; "
                   "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                   "print(child.pid, flush=True)"]
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / "launcher.log"
            child = None
            try:
                with log.open("wb") as out, launch_owned_process(command, cwd=temp, env=os.environ.copy(), stdout=out) as launcher:
                    self.assertEqual(launcher.wait(timeout=10), 0)
                    child = psutil.Process(int(log.read_text(encoding="utf-8").strip()))
                    self.assertTrue(child.is_running())
                if os.name == "nt":
                    child.wait(timeout=10)
                    self.assertFalse(child.is_running())
                else:
                    # An orphan may remain as a zombie until its new parent reaps it.
                    deadline = replay.time.monotonic() + 10
                    while child.is_running() and child.status() != psutil.STATUS_ZOMBIE:
                        self.assertLess(replay.time.monotonic(), deadline)
                        replay.time.sleep(.05)
            finally:
                if child is not None and child.is_running():
                    try:
                        child.kill()
                    except psutil.NoSuchProcess:
                        pass

    def test_gpu_owner_rejects_entry_points_outside_the_candidate_checkout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "candidate"
            entry_point = source / "server/src/main.py"
            outside = root / "other-checkout/server/src/main.py"
            for path in (entry_point, outside):
                path.parent.mkdir(parents=True)
                path.write_text("# synthetic fixture\n", encoding="utf-8")
            pid_file = root / "server.pid"
            pid_file.write_text(json.dumps({"pid": 123, "port": 456}), encoding="utf-8")
            args = SimpleNamespace(source=source, pid_file=pid_file)
            process = Mock()
            process.cwd.return_value = str(source / "server")
            process.exe.return_value = "python.exe"
            for command in (["python", str(outside)], ["python", str(outside), str(entry_point)],
                            ["python", "-m", "src.main", str(entry_point)]):
                with (self.subTest(command=command),
                      patch.object(replay.subprocess, "check_output", side_effect=[str(source), score.CANDIDATE["commit"], ""]),
                      patch.object(replay.psutil, "Process", return_value=process),
                      patch.object(replay, "has_loopback_listener") as listener):
                    process.cmdline.return_value = command
                    with self.assertRaisesRegex(ValueError, "does not launch the candidate entry point"):
                        replay.gpu_owner(args)
                    listener.assert_not_called()

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
            await replay.run_gpu(SimpleNamespace(output=None, entity_audit=None))
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
