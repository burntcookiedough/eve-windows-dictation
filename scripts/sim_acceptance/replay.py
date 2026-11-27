"""Run and score real-time public WAV replays against an owned localhost server."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from contextlib import asynccontextmanager, nullcontext
from functools import partial
from itertools import pairwise
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

import psutil
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.perf_regression_benchmark import replay_trial
from scripts.sim_acceptance.owned_process import launch_owned_process
from scripts.sim_acceptance.score import (
    CANDIDATE,
    add_candidate_argument,
    load_clips,
    resolve_candidate,
    trial_record,
    write_evidence,
)

GIB = 1024**3
HTTP = build_opener(ProxyHandler({}))
MAX_SAMPLE_GAP_S = 2.5
SAMPLE_BOUNDARY_TOLERANCE_S = 2
REPLAY_ERRORS = (OSError, TimeoutError, RuntimeError, WebSocketException)
LOCAL_REPLAY_CONNECT = partial(connect, proxy=None)


def get_json(port, endpoint):
    if not 0 < port <= 65535 or not endpoint.startswith("/"):
        raise ValueError("QA HTTP address is invalid")
    with HTTP.open(f"http://127.0.0.1:{port}{endpoint}", timeout=3) as response:
        return json.load(response)


def has_loopback_listener(process, port):
    if type(port) is not int or not 0 < port <= 65535:
        return False
    try:
        return (process.is_running()
                and any(conn.status == psutil.CONN_LISTEN and conn.laddr.ip == "127.0.0.1"
                        and conn.laddr.port == port for conn in process.net_connections("tcp4"))
                and process.is_running())
    except (psutil.Error, OSError):
        return False


class ProcessSamples:
    def __init__(self, process, required_child=None):
        try:
            self.root = psutil.Process(process) if isinstance(process, int) else process
        except (psutil.Error, OSError):
            self.root = None
        self.required_child = required_child
        self.samples = []
        self.sample_errors = 0

    def sample(self):
        try:
            if self.root is None or not self.root.is_running():
                raise psutil.NoSuchProcess(self.root.pid if self.root else -1)
            processes = [self.root, *self.root.children(recursive=True)]
            if self.required_child is not None and all(p.pid != self.required_child for p in processes):
                raise psutil.NoSuchProcess(self.required_child)
            by_process = {}
            rss = 0
            for process in processes:
                with process.oneshot():
                    cpu = process.cpu_times()
                    memory = process.memory_info().rss
                    by_process[(process.pid, process.create_time())] = cpu.user + cpu.system
                    rss += memory
            self.samples.append((time.perf_counter(), rss, by_process))
        except (psutil.Error, OSError):
            self.sample_errors += 1

    async def collect(self, stop):
        while not stop.is_set():
            await asyncio.to_thread(self.sample)
            try:
                await asyncio.wait_for(stop.wait(), timeout=1)
            except TimeoutError:
                continue
        await asyncio.to_thread(self.sample)

    @asynccontextmanager
    async def watch(self):
        stop = asyncio.Event()
        collection = asyncio.create_task(self.collect(stop))
        try:
            yield
        finally:
            stop.set()
            await collection

    def covered(self, samples, started, ended):
        return bool(samples and not self.sample_errors and
                    abs(samples[0][0] - started) <= SAMPLE_BOUNDARY_TOLERANCE_S and
                    abs(samples[-1][0] - ended) <= SAMPLE_BOUNDARY_TOLERANCE_S and
                    all(after[0] - before[0] <= MAX_SAMPLE_GAP_S
                        for before, after in pairwise(samples)))

    def idle(self, started, ended):
        valid_time = 0
        cpu_time = 0
        for (since, _, before), (until, _, after) in pairwise(self.samples):
            if before.keys() == after.keys() and until - since <= MAX_SAMPLE_GAP_S:
                valid_time += until - since
                cpu_time += sum(after[key] - before[key] for key in after)
        covered = ended - started >= 120 and self.covered(self.samples, started, ended)
        peak = max((row[1] for row in self.samples), default=None)
        return {
            "idle_rss_gib": peak / GIB if peak is not None else None,
            "idle_cpu_pct": 100 * cpu_time / valid_time / (os.cpu_count() or 1)
            if covered and valid_time >= 120 else None,
            "idle_cpu_valid_s": valid_time,
            "idle_sample_count": len(self.samples),
            "idle_sample_errors": self.sample_errors,
            "idle_rss_window_covered": covered,
        }

    def long(self, capture_start, stop_time, ended):
        window = ([(stamp, rss, cpu) for stamp, rss, cpu in self.samples
                   if capture_start <= stamp <= ended]
                  if capture_start is not None and ended is not None else [])
        covered = (bool(window) and stop_time is not None and capture_start <= stop_time <= ended
                   and abs(stop_time - capture_start - 1800) <= SAMPLE_BOUNDARY_TOLERANCE_S
                   and self.covered(window, capture_start, ended))
        peak = max((row[1] for row in window), default=None)
        growth = None
        if covered:
            minute5 = min(window, key=lambda row: abs(row[0] - capture_start - 300))
            minute30 = next((row for row in reversed(window) if row[0] <= stop_time), None)
            if (minute30 and minute5[1] > 0
                    and abs(minute30[0] - stop_time) <= SAMPLE_BOUNDARY_TOLERANCE_S
                    and abs(minute5[0] - capture_start - 300) <= SAMPLE_BOUNDARY_TOLERANCE_S):
                growth = 100 * (minute30[1] - minute5[1]) / minute5[1]
        return {
            "long_peak_rss_gib": peak / GIB if peak is not None else None,
            "long_rss_growth_pct": growth,
            "long_sample_count": len(self.samples),
            "long_window_sample_count": len(window),
            "long_sample_errors": self.sample_errors,
            "long_rss_window_covered": covered,
        }


async def idle_resources(process, server_pid=None):
    samples = ProcessSamples(process, required_child=server_pid)
    started = time.perf_counter()
    async with samples.watch():
        await asyncio.sleep(122)
        ended = time.perf_counter()
    return samples.idle(started, ended)


async def wait_health(port, device, model, timeout):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            health = await asyncio.to_thread(get_json, port, "/health")
        except OSError:
            health = {}
        runtime = health.get("runtime", {})
        engine = health.get("engine", {})
        if (health.get("status") == "healthy" and health.get("version") == "0.9.0-beta.1"
                and engine.get("status") == "ready" and runtime.get("effective_device") == device
                and (engine.get("info") or {}).get("model") == model
                and health.get("active_sessions") == 0):
            return health
        if engine.get("status") == "error":
            raise RuntimeError("Candidate model startup reported an error")
        await asyncio.sleep(1)
    raise RuntimeError("Candidate did not reach the required ready model and device")


async def run_replay(port, process, clips, result, result_file, audit=None):
    url = f"ws://127.0.0.1:{port}/transcribe"
    # A separate, excluded warm-up. One measurement is retained per declared clip.
    try:
        warmup = await replay_trial(url, clips[0], timeout=120, connect=LOCAL_REPLAY_CONNECT)
        result["warmup_ok"] = warmup["outcome"] == "success" and bool(warmup["text"])
    except REPLAY_ERRORS as error:
        result["warmup_ok"] = False
        result["warmup_fixture_gap"] = type(error).__name__
        if not await asyncio.to_thread(has_loopback_listener, process, port):
            result["replay_stopped_reason"] = "owned-listener-unavailable-after-warmup"
            write_evidence(result_file, result)
            return
    write_evidence(result_file, result)
    result["resources"].update(await idle_resources(process))
    write_evidence(result_file, result)
    for clip in clips:
        long_trial = clip["mode"] == "long"
        started = time.perf_counter()
        resources = ProcessSamples(process) if long_trial else None
        observation = {}
        transport_failed = False
        async with resources.watch() if resources else nullcontext():
            try:
                observation = await replay_trial(url, clip, timeout=180 if long_trial else 120,
                                                 connect=LOCAL_REPLAY_CONNECT)
                hypothesis = observation["text"] or ""
                fields = {"failed": observation["outcome"] != "success"}
                latency = observation["stop_to_final_text_ms"]
            except REPLAY_ERRORS as error:
                hypothesis = latency = None
                fields = {"fixture_gap": type(error).__name__}
                transport_failed = True
            scored = trial_record(
                clip, hypothesis, output_observed=hypothesis is not None,
                elapsed_s=time.perf_counter() - started, stop_to_final_ms=latency, **fields,
            )
            result["trials"].append(scored)
            write_evidence(result_file, result)
        if resources:
            result["resources"].update(resources.long(
                observation.get("stream_started_at"), observation.get("stop_requested_at"),
                observation.get("final_received_at"),
            ))
            write_evidence(result_file, result)
        if audit is not None:
            audit.observe(clip, hypothesis, scored)
        print(f"{clip['id']}: replay finalized={latency is not None}", flush=True)
        if transport_failed and not await asyncio.to_thread(has_loopback_listener, process, port):
            result["replay_stopped_reason"] = "owned-listener-unavailable-after-trial"
            write_evidence(result_file, result)
            break


def verify_candidate_source(source, expected_commit):
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}

    def git(*args):
        # Git prints paths as UTF-8 regardless of the console code page.
        return subprocess.check_output(["git", "-C", source, *args], env=env, encoding="utf-8").strip()

    top_level = git("rev-parse", "--show-toplevel")
    if Path(top_level).resolve() != source.resolve():
        raise ValueError("GPU server source must be the candidate Git worktree root")
    head = git("rev-parse", "HEAD")
    changed = git("status", "--porcelain")
    if head != expected_commit or changed:
        raise ValueError("GPU server requires the clean verified candidate source commit")


def require_test_gpu():
    gpus = subprocess.check_output(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], text=True)
    if "RTX 3060 Laptop GPU" not in gpus:
        raise ValueError("The required RTX 3060 Laptop GPU is unavailable")


def gpu_owner(args):
    source = args.source.resolve()
    verify_candidate_source(source, CANDIDATE["commit"])
    owner = json.loads(args.pid_file.read_text(encoding="utf-8"))
    process = psutil.Process(owner["pid"])
    cwd = Path(process.cwd()).resolve()
    if not cwd.is_relative_to(source):
        raise ValueError("GPU server PID is outside the candidate checkout")
    command = process.cmdline()
    entry_point = (source / "server/src/main.py").resolve()
    if (not entry_point.is_relative_to(source) or len(command) < 2
            or not re.fullmatch(r"python(?:3(?:\.[0-9]+)?)?(?:\.exe)?", Path(process.exe()).name, re.IGNORECASE)
            or (cwd / command[1]).resolve() != entry_point):
        raise ValueError("GPU server PID does not launch the candidate entry point")
    if not has_loopback_listener(process, owner["port"]):
        raise ValueError("GPU server PID does not own the specified loopback listener")
    require_test_gpu()
    return owner, process


async def observe_gpu(args, candidate, owner, process, output, audit_path):
    health = await wait_health(owner["port"], "cuda", "large-v3-turbo", 1800)
    if not await asyncio.to_thread(has_loopback_listener, process, owner["port"]):
        raise ValueError("GPU server no longer owns the specified loopback listener")
    if health["runtime"].get("pack_id"):
        raise ValueError("Development CUDA replay must use the system toolkit")
    clips = load_clips(args.manifest, "gpu-close-quiet")
    result = {
        "candidate": candidate, "config": "gpu-close-quiet", "method": "source-cuda-replay",
        "device": "cuda", "model": "large-v3-turbo", "gpu": "RTX 3060 Laptop GPU",
        "resources": {}, "trials": [],
    }
    write_evidence(output, result)
    audit = None
    if audit_path:
        from scripts.sim_acceptance.entity_audit import EntityAudit

        audit = EntityAudit(audit_path, "gpu-close-quiet", candidate)
    await run_replay(owner["port"], process, clips, result, output, audit)
    return result


async def wait_for_gpu_child(launcher, pid_file):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if launcher.poll() is not None:
            raise RuntimeError("Launched GPU server exited during startup")
        try:
            owner = json.loads(pid_file.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            await asyncio.sleep(.1)
            continue
        # A Windows venv redirector can launch the Python interpreter as a child.
        process = launcher if owner["pid"] == launcher.pid else next(
            (child for child in launcher.children(recursive=True) if child.pid == owner["pid"]), None,
        )
        if process is None or not await asyncio.to_thread(has_loopback_listener, process, owner["port"]):
            raise ValueError("Launched GPU server does not own the reported loopback listener")
        return owner, process
    raise RuntimeError("Launched GPU server did not publish its PID file")


async def watch_gpu_child(launcher, process):
    while launcher.poll() is None and process.is_running():
        await asyncio.sleep(.25)
    raise RuntimeError("Launched GPU server exited during replay")


async def run_gpu(args, *, candidate=None):
    if candidate is None:
        owner, process = await asyncio.to_thread(gpu_owner, args)
        await observe_gpu(args, CANDIDATE, owner, process, args.output, args.entity_audit)
        return
    if args.pid_file is not None:
        raise ValueError("--candidate launches its own server and cannot use --pid-file")

    source = args.source.resolve()
    verify_candidate_source(source, candidate["commit"])
    server = (source / "server").resolve()
    entry_point = (server / "src/main.py").resolve()
    if not server.is_relative_to(source) or not entry_point.is_relative_to(server) or not entry_point.is_file():
        raise ValueError("Candidate checkout must provide its own server entry point")
    python = server / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
    if not python.is_file():
        raise ValueError("Prepare the candidate server's development venv before replay")
    require_test_gpu()
    output_dir = args.output.resolve().parent
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="eve-cuda-", dir=output_dir) as directory:
        scratch = Path(directory)
        pid_file = scratch / "server.pid"
        cache = output_dir / "hf"
        env = {**os.environ, "TEMP": str(scratch), "TMP": str(scratch),
               "HF_HOME": str(cache), "HF_HUB_CACHE": str(cache / "hub"),
               "HUGGINGFACE_HUB_CACHE": str(cache / "hub"), "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
               "PYTHONNOUSERSITE": "1", "MURMUR_HOST": "127.0.0.1", "MURMUR_PORT": "0",
               "MURMUR_PID_FILE": str(pid_file), "MURMUR_SETTINGS_FILE": str(scratch / "settings.json"),
               "MURMUR_PERF_TRACE": "1", "MURMUR_WHISPER_MODEL": "large-v3-turbo", "MURMUR_WHISPER_DEVICE": "cuda"}
        for name in ("PYTHONPATH", "PYTHONHOME", "MURMUR_GPU_RUNTIME_DIR", "MURMUR_GPU_PACK_ID"):
            env.pop(name, None)
        with ((scratch / "server.log").open("wb") as log,
              launch_owned_process([str(python), "-B", str(entry_point)], cwd=server, env=env, stdout=log) as launcher):
            owner, process = await wait_for_gpu_child(launcher, pid_file)
            audit_path = scratch / "audit.json" if args.entity_audit else None
            replay_task = asyncio.create_task(observe_gpu(args, candidate, owner, process, scratch / "evidence.json", audit_path))
            watch_task = asyncio.create_task(watch_gpu_child(launcher, process))
            try:
                done, _ = await asyncio.wait((replay_task, watch_task), return_when=asyncio.FIRST_COMPLETED)
                if watch_task in done:
                    await watch_task
                result = await replay_task
                owns_listener = await asyncio.to_thread(has_loopback_listener, process, owner["port"])
                if not owns_listener or launcher.poll() is not None or result.get("replay_stopped_reason"):
                    raise RuntimeError("Launched GPU server was lost during replay")
                if audit_path is not None and audit_path.is_file():
                    write_evidence(args.entity_audit, json.loads(audit_path.read_text(encoding="utf-8")))
                write_evidence(args.output, result)
            finally:
                for task in (replay_task, watch_task):
                    task.cancel()
                await asyncio.gather(replay_task, watch_task, return_exceptions=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--pid-file", type=Path, help="PID file for the original candidate's external server")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    add_candidate_argument(parser)
    parser.add_argument("--entity-audit", type=Path)
    args = parser.parse_args()
    if (args.candidate is None) == (args.pid_file is None):
        parser.error("provide --candidate to launch a server, or --pid-file for the original candidate")
    candidate = resolve_candidate(parser, args.candidate) if args.candidate is not None else None
    asyncio.run(run_gpu(args, candidate=candidate))


if __name__ == "__main__":
    main()
