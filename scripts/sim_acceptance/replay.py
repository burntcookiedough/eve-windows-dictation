"""Run and score real-time public WAV replays against an owned localhost server."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from contextlib import asynccontextmanager, nullcontext
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

import psutil
from websockets.exceptions import WebSocketException

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.perf_regression_benchmark import replay_trial
from scripts.sim_acceptance.score import (
    CANDIDATE,
    load_clips,
    trial_record,
    write_evidence,
)

GIB = 1024**3
HTTP = build_opener(ProxyHandler({}))
MAX_SAMPLE_GAP_S = 2.5
SAMPLE_BOUNDARY_TOLERANCE_S = 2
REPLAY_ERRORS = (OSError, TimeoutError, RuntimeError, WebSocketException)


def get_json(port, endpoint):
    if not 0 < port <= 65535 or not endpoint.startswith("/"):
        raise ValueError("QA HTTP address is invalid")
    with HTTP.open(f"http://127.0.0.1:{port}{endpoint}", timeout=3) as response:
        return json.load(response)


class ProcessSamples:
    def __init__(self, pid, required_child=None):
        try:
            self.root = psutil.Process(pid)
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

    def covered(self, started, ended):
        return bool(self.samples and not self.sample_errors and
                    abs(self.samples[0][0] - started) <= SAMPLE_BOUNDARY_TOLERANCE_S and
                    abs(self.samples[-1][0] - ended) <= SAMPLE_BOUNDARY_TOLERANCE_S and
                    all(after[0] - before[0] <= MAX_SAMPLE_GAP_S
                        for before, after in zip(self.samples, self.samples[1:])))

    def idle(self, started, ended):
        valid_time = 0
        cpu_time = 0
        for (since, _, before), (until, _, after) in zip(self.samples, self.samples[1:]):
            if before.keys() == after.keys() and until - since <= MAX_SAMPLE_GAP_S:
                valid_time += until - since
                cpu_time += sum(after[key] - before[key] for key in after)
        covered = ended - started >= 120 and self.covered(started, ended)
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
        covered = (stop_time is not None
                   and abs(stop_time - capture_start - 1800) <= SAMPLE_BOUNDARY_TOLERANCE_S
                   and self.covered(capture_start, ended))
        peak = max((row[1] for row in self.samples), default=None)
        growth = None
        if covered:
            minute5 = min(self.samples, key=lambda row: abs(row[0] - capture_start - 300))
            minute30 = next((row for row in reversed(self.samples) if row[0] <= stop_time), None)
            if (minute30 and minute5[1] > 0
                    and abs(minute30[0] - stop_time) <= SAMPLE_BOUNDARY_TOLERANCE_S
                    and abs(minute5[0] - capture_start - 300) <= SAMPLE_BOUNDARY_TOLERANCE_S):
                growth = 100 * (minute30[1] - minute5[1]) / minute5[1]
        return {
            "long_peak_rss_gib": peak / GIB if peak is not None else None,
            "long_rss_growth_pct": growth,
            "long_sample_count": len(self.samples),
            "long_sample_errors": self.sample_errors,
            "long_rss_window_covered": covered,
        }


async def idle_resources(pid, server_pid=None):
    samples = ProcessSamples(pid, required_child=server_pid)
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


async def run_replay(port, pid, clips, result, result_file, audit=None):
    url = f"ws://127.0.0.1:{port}/transcribe"
    # A separate, excluded warm-up. One measurement is retained per declared clip.
    try:
        warmup = await replay_trial(url, clips[0], timeout=120)
        result["warmup_ok"] = warmup["outcome"] == "success" and bool(warmup["text"])
    except REPLAY_ERRORS as error:
        result["warmup_ok"] = False
        result["warmup_fixture_gap"] = type(error).__name__
    write_evidence(result_file, result)
    result["resources"].update(await idle_resources(pid))
    write_evidence(result_file, result)
    for clip in clips:
        long_trial = clip["mode"] == "long"
        capture_start = time.perf_counter()
        resources = ProcessSamples(pid) if long_trial else None
        async with resources.watch() if resources else nullcontext():
            try:
                observation = await replay_trial(url, clip, timeout=180 if long_trial else 120)
                hypothesis = observation["text"] or ""
                fields = {"failed": observation["outcome"] != "success"}
                latency = observation["stop_to_final_text_ms"]
            except REPLAY_ERRORS as error:
                hypothesis = latency = None
                fields = {"fixture_gap": type(error).__name__}
            ended = time.perf_counter()
        if resources:
            # The replay benchmark exposes the final duration, so the stop
            # estimate includes connection teardown before the function returns.
            stop = ended - latency / 1000 if latency is not None else None
            result["resources"].update(resources.long(capture_start, stop, ended))
        scored = trial_record(
            clip, hypothesis, output_observed=hypothesis is not None,
            elapsed_s=ended - capture_start, stop_to_final_ms=latency, **fields,
        )
        if audit is not None:
            audit.observe(clip, hypothesis, scored)
        result["trials"].append(scored)
        write_evidence(result_file, result)
        print(f"{clip['id']}: replay finalized={latency is not None}", flush=True)


def gpu_owner(args):
    source = args.source.resolve()
    head = subprocess.check_output(["git", "-C", source, "rev-parse", "HEAD"], text=True).strip()
    changed = subprocess.check_output(["git", "-C", source, "status", "--porcelain"], text=True).strip()
    if head != CANDIDATE["commit"] or changed:
        raise ValueError("GPU server requires the clean verified candidate source commit")
    owner = json.loads(args.pid_file.read_text(encoding="utf-8"))
    process = psutil.Process(owner["pid"])
    if not Path(process.cwd()).resolve().is_relative_to(source):
        raise ValueError("GPU server PID is outside the candidate checkout")
    if not any(Path(arg).name == "main.py" for arg in process.cmdline()[1:]):
        raise ValueError("GPU server PID does not launch the candidate entry point")
    gpus = subprocess.check_output(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], text=True)
    if "RTX 3060 Laptop GPU" not in gpus:
        raise ValueError("The required RTX 3060 Laptop GPU is unavailable")
    return owner


async def run_gpu(args):
    owner = await asyncio.to_thread(gpu_owner, args)
    health = await wait_health(owner["port"], "cuda", "large-v3-turbo", 1800)
    if health["runtime"].get("pack_id"):
        raise ValueError("Development CUDA replay must use the system toolkit")
    clips = load_clips(args.manifest, "gpu-close-quiet")
    result = {
        "candidate": CANDIDATE, "config": "gpu-close-quiet", "method": "source-cuda-replay",
        "device": "cuda", "model": "large-v3-turbo", "gpu": "RTX 3060 Laptop GPU",
        "resources": {}, "trials": [],
    }
    write_evidence(args.output, result)
    audit = None
    if args.entity_audit:
        from scripts.sim_acceptance.entity_audit import EntityAudit

        audit = EntityAudit(args.entity_audit, "gpu-close-quiet", CANDIDATE)
    await run_replay(owner["port"], owner["pid"], clips, result, args.output, audit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--pid-file", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--entity-audit", type=Path)
    asyncio.run(run_gpu(parser.parse_args()))


if __name__ == "__main__":
    main()
