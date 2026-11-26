"""Exercise the retained Eve build on a disposable GitHub-hosted Windows runner."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import socket
import struct
import subprocess
import sys
import time
import wave
from contextlib import asynccontextmanager
from itertools import pairwise
from pathlib import Path

import psutil
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, WebSocketException

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.sim_acceptance.replay import (
    ProcessSamples,
    get_json,
    run_replay,
    wait_health,
)
from scripts.sim_acceptance.score import (
    CANDIDATE,
    load_clips,
    text_hash,
    trial_record,
    write_evidence,
)
from scripts.validation_harness import normalize_text

HERE = Path(__file__).resolve().parent
MODEL = "small"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CDP_SCRIPT = """(() => {
  window.eveQaState = { finals: [], editorDuringSpeech: 0, history: [], recording: null, delivery: null };
  window.murmurMain.onTranscription(payload => {
    if (payload.type === 'final') window.eveQaState.finals.push(payload.text);
    else window.eveQaState.editorDuringSpeech++;
  });
  window.murmurMain.onRecordingState(payload => {
    window.eveQaState.recording = payload;
    if (payload.delivery) window.eveQaState.delivery = payload.delivery;
  });
  window.murmurMain.onNewHistoryEntry(payload => window.eveQaState.history.push(payload.id));
  return true;
})()"""
LISTENING = {"listening", "transcribing"}
FIXTURE_REASONS = {
    "bundled-replay-server-exited", "cdp-command-error", "cdp-http-unreachable",
    "cdp-websocket-unavailable", "desktop-command-timeout", "desktop-editor-exited",
    "desktop-editor-unavailable", "editor-foreground-unavailable", "editor-no-longer-foreground",
    "fake-track-did-not-end", "global-hotkey-unobserved", "installed-version-mismatch",
    "invalid-hosted-scratch", "main-renderer-unavailable", "managed-model-not-ready-in-app",
    "managed-server-listener-mismatch", "managed-server-no-longer-owned",
    "managed-server-ownership-unverified", "packaged-model-not-ready", "qa-clipboard-allocation-failed",
    "qa-clipboard-lock-failed", "qa-clipboard-seed-failed", "qa-clipboard-unavailable",
    "renderer-command-error", "renderer-preload-unavailable", "replay-server-pid-mismatch",
    "sendinput-unavailable", "settings-save-unobserved", "socket-did-not-enter-ready",
    "unexpected-cdp-endpoint", "unknown-desktop-command", "warmup-clipboard-not-restored",
    "warmup-editor-insertion-unobserved", "warmup-editor-insertion-timing-unobserved",
    "warmup-editor-stop-key-unobserved",
    "warmup-native-editor-control-unobserved", "warmup-packaged-capture-unavailable",
    "warmup-paste-skipped-before-helper",
} | {f"fake-capture-no-first-audio-{phase}" for phase in (
    "idle", "listening", "transcribing", "processing", "success", "notice", "error"
)}


class FixtureUnavailable(RuntimeError):
    pass


def fixture_reason(error):
    if isinstance(error, FixtureUnavailable):
        reason = str(error)
        return reason if reason in FIXTURE_REASONS else "unspecified-fixture"
    if isinstance(error, ConnectionClosed):
        return "cdp-connection-closed"
    return type(error).__name__


async def poll(observe, condition, seconds, *, failure=None):
    deadline = time.perf_counter() + seconds
    while time.perf_counter() < deadline:
        value = await observe()
        if condition(value):
            return value
        await asyncio.sleep(.08)
    if failure is not None:
        raise FixtureUnavailable(failure)
    raise TimeoutError("observation-timeout")


async def http(port, endpoint):
    try:
        return await asyncio.to_thread(get_json, port, endpoint)
    except OSError:
        return None


def cdp_socket(target, port, kind):
    url = target.get("webSocketDebuggerUrl", "")
    if not re.fullmatch(rf"ws://127\.0\.0\.1:{port}/devtools/{kind}/[\w-]+", url):
        raise FixtureUnavailable("unexpected-cdp-endpoint")
    return url


async def open_cdp(target, port, kind):
    url = cdp_socket(target, port, kind)
    try:
        return await connect(url, close_timeout=2)
    except (OSError, TimeoutError, WebSocketException) as error:
        raise FixtureUnavailable("cdp-websocket-unavailable") from error


class Cdp:
    def __init__(self, ws):
        self.ws = ws
        self.sequence = 0

    async def send(self, method, params=None):
        self.sequence += 1
        await self.ws.send(json.dumps({"id": self.sequence, "method": method, "params": params or {}}))
        async with asyncio.timeout(10):
            while True:
                result = json.loads(await self.ws.recv())
                if result.get("id") == self.sequence:
                    if "error" in result:
                        raise FixtureUnavailable("cdp-command-error")
                    return result["result"]

    async def eval(self, expression):
        result = await self.send("Runtime.evaluate", {
            "expression": expression, "awaitPromise": True, "returnByValue": True,
        })
        if result.get("exceptionDetails"):
            raise FixtureUnavailable("renderer-command-error")
        return result["result"].get("value")


class Desktop:
    def __init__(self, process):
        self.process = process

    async def send(self, action, **fields):
        if self.process.returncode is not None:
            raise FixtureUnavailable("desktop-editor-exited")
        self.process.stdin.write((json.dumps({"action": action, **fields}) + "\n").encode())
        await self.process.stdin.drain()
        try:
            raw = await asyncio.wait_for(self.process.stdout.readline(), 10)
        except TimeoutError as error:
            raise FixtureUnavailable("desktop-command-timeout") from error
        if not raw:
            raise FixtureUnavailable("desktop-editor-unavailable")
        reply = json.loads(raw)
        if "error" in reply:
            raise FixtureUnavailable(reply["error"])
        return reply["result"]


def localhost_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def stop_owned_tree(process):
    if process.poll() is not None:
        return
    root = psutil.Process(process.pid)
    children = root.children(recursive=True)
    for member in [*reversed(children), root]:
        try:
            member.kill()
        except psutil.NoSuchProcess:
            pass
    process.wait(timeout=20)


def start_process(command, cwd, env, stdout, stderr):
    with stdout.open("wb") as out, stderr.open("wb") as err:
        return subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=out, stderr=err, creationflags=NO_WINDOW)


def runtime_environment(root):
    env = os.environ.copy()
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        env.pop(name, None)
    env.update({
        "TEMP": str(root / "runtime-temp"), "TMP": str(root / "runtime-temp"),
        "HF_HOME": str(root / "hf"), "HF_HUB_CACHE": str(root / "hf" / "hub"),
        "HUGGINGFACE_HUB_CACHE": str(root / "hf" / "hub"),
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DOWNLOAD_TIMEOUT": "120", "PYTHONNOUSERSITE": "1",
        "CUDA_VISIBLE_DEVICES": "-1", "MURMUR_PERF_TRACE": "1",
        "MURMUR_WHISPER_DEVICE": "cpu", "MURMUR_WHISPER_LANGUAGE": "en",
    })
    return env


def candidate_settings(profile):
    profile.mkdir(parents=True, exist_ok=True)
    defaults = profile / "settings.json"
    if not defaults.exists():
        hotkey = {"ctrlKey": False, "altKey": False, "shiftKey": False, "metaKey": False}
        write_evidence(defaults, {
            "hotkey": {**hotkey, "keycode": 0x43},
            "longHotkey": {**hotkey, "keycode": 0x44},
            "holdToTalk": False, "startMinimized": False, "serverAutoStart": True,
            "autoCopy": False, "autoPaste": True, "restoreClipboardAfterPaste": True,
            "dictationMode": "raw", "silenceTimeout": 15,
        })
        write_evidence(profile / "server-settings.json", {"whisper_model": MODEL})
    else:
        settings = json.loads(defaults.read_text(encoding="utf-8"))
        if settings.get("autoCopy") is not False:
            settings["autoCopy"] = False
            write_evidence(defaults, settings)


@asynccontextmanager
async def app_session(root, install, clip, *, trace=True, label=None, wait_for_model=True,
                      offline_cache=None):
    profile = root / "profile" / "Eve"
    candidate_settings(profile)
    env = runtime_environment(root)
    env["MURMUR_PERF_TRACE"] = "1" if trace else "0"
    if offline_cache is not None:
        env.update({
            "HF_HOME": str(offline_cache), "HF_HUB_CACHE": str(offline_cache / "hub"),
            "HUGGINGFACE_HUB_CACHE": str(offline_cache / "hub"), "HF_HUB_OFFLINE": "1",
        })
    cdp_port = localhost_port()
    name = label or clip["id"]
    stdout, stderr = (root / f"{name}.{stream}.log" for stream in ("out", "err"))
    process = start_process([
        str(install / "Eve.exe"), "--eve-qa-isolation", f"--eve-qa-user-data-root={profile}",
        f"--remote-debugging-port={cdp_port}", "--remote-debugging-address=127.0.0.1",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        f"--use-file-for-fake-audio-capture={clip['audio']}%noloop",
    ], install, env, stdout, stderr)
    browser = None
    try:
        version = await poll(lambda: http(cdp_port, "/json/version"), bool, 20,
                             failure="cdp-http-unreachable")
        browser = await open_cdp(version, cdp_port, "browser")
        url = (install / "resources/app.asar/dist/renderer/app/index.html").as_uri().lower()
        pages = await poll(lambda: http(cdp_port, "/json/list"), lambda targets: bool(targets)
                           and any(page.get("url", "").lower() == url for page in targets), 20,
                           failure="main-renderer-unavailable")
        target, = [page for page in pages if page.get("type") == "page" and page.get("url", "").lower() == url]
        async with await open_cdp(target, cdp_port, "page") as ws:
            main = Cdp(ws)
            main.port = cdp_port
            await poll(lambda: main.eval("typeof window.murmurMain?.getAppVersion === 'function'"), bool, 15,
                       failure="renderer-preload-unavailable")
            version = await main.eval("window.murmurMain.getAppVersion()")
            if version != "0.9.0-beta.1":
                raise FixtureUnavailable("installed-version-mismatch")
            await main.eval(CDP_SCRIPT)
            owner_file = profile / "server.pid"

            async def server_port():
                if not owner_file.exists():
                    return None
                owner = json.loads(owner_file.read_text(encoding="utf-8"))
                owned = {child.pid for child in psutil.Process(process.pid).children(recursive=True)}
                if owner["pid"] not in owned:
                    return None
                executable = Path(psutil.Process(owner["pid"]).exe()).resolve()
                if not executable.is_relative_to(install / "resources/server"):
                    return None
                return owner

            owner = await poll(server_port, bool, 45, failure="managed-server-ownership-unverified")
            if wait_for_model:
                try:
                    await wait_health(owner["port"], "cpu", MODEL, 720)
                except (RuntimeError, TimeoutError) as error:
                    raise FixtureUnavailable("packaged-model-not-ready") from error
                # The app rejects dictation until its own managed-server
                # snapshot is ready, which can lag the direct health endpoint.
                await poll(
                    lambda: main.eval("window.murmurMain.getServerStatus()"),
                    lambda state: bool(state)
                    and state.get("status") == "running"
                    and state.get("pid") == owner["pid"]
                    and state.get("port") == owner["port"]
                    and (state.get("engineStatus") or {}).get("status") == "ready",
                    30, failure="managed-model-not-ready-in-app",
                )
            yield main, process, owner, stdout, stderr
    finally:
        if browser is not None:
            try:
                await Cdp(browser).send("Browser.close")
            except (OSError, TimeoutError, RuntimeError, ConnectionClosed):
                pass
            finally:
                await browser.close()
        try:
            await asyncio.to_thread(process.wait, 12)
        except subprocess.TimeoutExpired:
            stop_owned_tree(process)


def read_perf(path):
    observations = []
    marker = ' B4_PERF trace="'
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if marker in line and line.endswith('"'):
            observations.append(json.loads(line.split(marker, 1)[1][:-1]))
    return observations


def detect_paste_diagnostics(*logs):
    signatures = {
        "dispatch_error": "Paste dispatch failed",
        "finalization_timeout": "Clipboard finalization timed out",
        "target_focus_refused": "Could not focus target window before paste",
        "target_invalid": "Target window no longer exists before paste",
        "target_not_foreground": "Target window is not foreground before paste",
    }
    text = "\n".join(path.read_text(encoding="utf-8", errors="replace") for path in logs)
    return {name: text.count(marker) for name, marker in signatures.items() if marker in text}


async def history(main):
    rows = await main.eval("window.murmurMain.getHistoryEntries(0, 100)")
    if rows["hasMore"]:
        raise RuntimeError("history-observer-limit")
    return {row["id"]: text_hash(row["text"]) for row in rows["entries"]}


def history_digest(entries):
    return text_hash(json.dumps(entries, sort_keys=True, separators=(",", ":")))


async def recording(main):
    return (await main.eval("window.murmurMain.getRecordingDebugState()"))["recording"]


@asynccontextmanager
async def overlay_observer(main, install):
    url = (install / "resources/app.asar/dist/renderer/overlay/index.html").as_uri().lower()
    pages = await poll(lambda: http(main.port, "/json/list"), lambda pages: bool(pages)
                       and any(page.get("url", "").lower() == url for page in pages), 15)
    target, = [page for page in pages if page.get("url", "").lower() == url]
    async with connect(cdp_socket(target, main.port, "page"), close_timeout=2) as ws:
        yield Cdp(ws)


async def idle_resources(process):
    sampler = ProcessSamples(process.pid)
    collect = asyncio.create_task(sampler.collect())
    try:
        await asyncio.sleep(122)
    finally:
        collect.cancel()
        await asyncio.gather(collect, return_exceptions=True)
    return sampler.idle()


async def capture(main, process, desktop, stdout, clip, *, time_idle=False, use_trace=True, audit=None):
    before = await history(main)
    if time_idle:
        idle = await idle_resources(process)
    else:
        idle = {}
    await desktop.send("reset")
    mode = clip["mode"]
    trigger = await desktop.send("key", mode=mode)

    async def first_audio():
        return next((trace for trace in reversed(read_perf(stdout))
                     if trace["main"]["firstAudioSentAt"] is not None), None)

    try:
        if use_trace:
            ready = await poll(first_audio, bool, 8)
        else:
            await poll(lambda: recording(main), lambda value: value["state"] in LISTENING, 8)
            ready = None
    except TimeoutError as error:
        state = await main.eval("window.eveQaState")
        if state["recording"] is None:
            raise FixtureUnavailable("global-hotkey-unobserved") from error
        phase = state["recording"]["state"]
        raise FixtureUnavailable(f"fake-capture-no-first-audio-{phase}") from error
    start = time.perf_counter()
    sampler = ProcessSamples(process.pid)
    collection = asyncio.create_task(sampler.collect()) if mode == "long" else None
    observed_stop = None
    try:
        await asyncio.sleep(clip["duration_s"])
        stop = await desktop.send("key", mode=mode)

        async def final_state():
            return await main.eval("window.murmurMain.getRecordingDebugState()")

        try:
            await poll(final_state, lambda state: state["recording"]["state"] == "idle",
                       180 if mode == "long" else 45)
            timed_out = False
        except TimeoutError:
            timed_out = True
        await asyncio.sleep(1)
        state = await main.eval("window.eveQaState")
        final = state["finals"][0] if len(state["finals"]) == 1 else None
        editor = await desktop.send("read", final=final)
        after = await history(main)
        keys = [stamp for key, stamp in editor["keys"] if key == mode]
        if len(keys) == 2 and keys[0] >= trigger and keys[1] >= stop:
            observed_stop = keys[1]
        insertion_times = [
            stamp for stamp in editor["insertions"] if observed_stop is not None and stamp >= observed_stop
        ]
        insertion_ms = (insertion_times[0] - observed_stop) * 1000 if len(insertion_times) == 1 else None
        history_restored = all(after.get(key) == value for key, value in before.items())
        delta = {key: value for key, value in after.items() if key not in before}
        history_correct = history_restored and list(delta.values()) == ([text_hash(final)] if final else [])
        marks = next((row["main"] for row in reversed(read_perf(stdout))
                      if ready and row["correlationId"] == ready["correlationId"]
                      and row["status"] == "complete"), {})
        stop_mark, final_mark = marks.get("stopRequestedAt"), marks.get("finalReceivedAt")
        internal = final_mark - stop_mark if stop_mark is not None and final_mark is not None else None
        difference = insertion_ms - internal if insertion_ms is not None and internal is not None else None
        hypothesis = editor["text"] or final or ""
        record = trial_record(
            clip, hypothesis, output_observed=True,
            failed=(timed_out or len(state["finals"]) != 1 or not history_correct
                    or state["editorDuringSpeech"] > 0 or len(editor["insertions"]) != 1),
            accuracy_source="editor" if editor["text"] else "packaged-final",
            insertion_count=len(editor["insertions"]), insert_matches_final=final == editor["text"],
            clipboard_restored=editor["clipboard_restored"], history_correct=history_correct,
            clipboard_matches_final=editor["clipboard_matches_final"], delivery=state["delivery"],
            history_delta=len(delta), history_count=len(after), final_count=len(state["finals"]),
            history_before_sha256=history_digest(before), history_after_sha256=history_digest(after),
            live_partial_count=state["editorDuringSpeech"], stop_to_insert_ms=insertion_ms,
            main_stop_to_final_ms=internal, capture_elapsed_s=stop - trigger,
            observed_insert_overhead_ms=difference if difference is not None and difference >= 0 else None,
            capture_startup_s=start - trigger, timed_out=timed_out,
            editor_stop_key_observed=observed_stop is not None,
            paste_helper_request_observed=marks.get("pasteHelperRequestSentAt") is not None,
            paste_helper_response_observed=marks.get("pasteHelperResponseAt") is not None,
            paste_diagnostics=detect_paste_diagnostics(
                stdout, stdout.with_name(stdout.name.replace(".out.log", ".err.log"))
            ),
        )
        if audit is not None:
            audit.observe(clip, hypothesis, record)
    finally:
        if collection is not None:
            collection.cancel()
            await asyncio.gather(collection, return_exceptions=True)
            sampler.sample()
    if collection is not None and observed_stop is not None:
        idle.update(sampler.long(start, observed_stop))
    return record, idle


def kill_managed_server(process, owner):
    server = next((child for child in psutil.Process(process.pid).children(recursive=True)
                   if child.pid == owner["pid"]), None)
    if server is None:
        raise FixtureUnavailable("managed-server-no-longer-owned")
    if not any(conn.status == psutil.CONN_LISTEN and conn.laddr.ip == "127.0.0.1"
               and conn.laddr.port == owner["port"] for conn in server.net_connections("tcp4")):
        raise FixtureUnavailable("managed-server-listener-mismatch")
    server.kill()
    server.wait(10)


async def interrupt_download(root, install, clip):
    async with app_session(root, install, clip, label="tls-interrupt",
                           wait_for_model=False) as (_, process, owner, _, _):
        async def downloading():
            health = await http(owner["port"], "/health")
            return ((health or {}).get("model_download") or {}).get("downloaded_bytes")

        received = await poll(downloading, lambda count: count and count > 0, 120)
        kill_managed_server(process, owner)
        return received


async def abrupt_socket(port, scratch):
    from scripts.perf_regression_benchmark import validate_url

    url = validate_url(f"ws://127.0.0.1:{port}/transcribe")
    temp_before = set(scratch.iterdir())
    baseline = (await http(port, "/health"))["active_sessions"]
    observations = []
    for _ in range(2):
        async with connect(url, close_timeout=2) as client:
            await client.send(json.dumps({"frame": "control", "type": "start", "silence_timeout": 60}))
            first = json.loads(await asyncio.wait_for(client.recv(), 5))
            if first.get("type") != "ready":
                raise FixtureUnavailable("socket-did-not-enter-ready")
            await client.send(struct.pack(">HHB", 0, 3200, 0) + b"\0" * 6400)
            during = await poll(lambda: http(port, "/health"),
                                lambda health: health and health["active_sessions"] == baseline + 1, 5)
            client.transport.abort()
        after = await poll(lambda: http(port, "/health"),
                           lambda health: health and health["active_sessions"] == baseline, 10)
        observations.append([during["active_sessions"], after["active_sessions"]])
    return {
        "sessions_before": baseline, "sessions_during_after": observations,
        "scratch_entries_unchanged": set(scratch.iterdir()) == temp_before,
    }


async def robustness(root, install, desktop, quick, evidence, output):
    scenarios = evidence["robustness"]

    def save(name, status, **fields):
        scenarios[name] = {"status": status, **fields}
        write_evidence(output, evidence)

    async def recover(label):
        async with app_session(root, install, quick, label=f"{label}-recovery") as (main, process, _, log, _):
            record, _ = await capture(main, process, desktop, log, quick)
            return record

    def delivered(record):
        return (not record["failed"] and record["insertion_count"] == record["final_count"] == 1
                and record["insert_matches_final"] and record["clipboard_restored"])

    async def microphone_scenario(label, clip, missing=False):
        async with app_session(root, install, clip, label=label) as (main, _, _, _, _):
            before = await history(main)
            if missing:
                await main.eval("window.murmurMain.updateSetting('selectedDeviceId','qa-unavailable-device')")
            try:
                await desktop.send("reset")
                await desktop.send("key", mode="quick")
                await asyncio.sleep(5 if label == "silence" else .25)
                if (await recording(main))["state"] in LISTENING:
                    await desktop.send("key", mode="quick")
                await poll(lambda: recording(main), lambda state: state["state"] == "idle", 25)
                after = await history(main)
                attempt = await desktop.send("read")
                state = await main.eval("window.eveQaState")
            finally:
                if missing:
                    await main.eval("window.murmurMain.updateSetting('selectedDeviceId','default')")
        recovery = await recover(label)
        ok = (before == after and not attempt["insertions"] and delivered(recovery)
              and recovery["history_before_sha256"] == history_digest(before)
              and state["recording"] is not None)
        save(label, "PASS" if ok else "FAIL", fault_insertions=len(attempt["insertions"]),
             recovery_insertions=recovery["insertion_count"], history_unchanged=before == after)

    async def paste_safety(label):
        async with app_session(root, install, quick, label=label) as (main, _, _, _, _):
            before = await history(main)
            if label == "focus-safety":
                await main.eval("window.murmurMain.updateSetting('autoCopy',true)")
            await desktop.send("reset")
            await desktop.send("key", mode="long" if label == "busy" else "quick")
            await poll(lambda: recording(main), lambda state: state["state"] in LISTENING, 5)
            await asyncio.sleep(quick["duration_s"])
            if label == "focus-safety":
                await desktop.send("replace-editor")
                await desktop.send("key", mode="quick")
            else:
                await desktop.send("key", mode="long")
                await poll(lambda: recording(main), lambda state: state["state"] == "processing", 3)
                await desktop.send("key", mode="long")
            await poll(lambda: recording(main), lambda state: state["state"] == "idle", 45)
            await asyncio.sleep(1)
            state = await main.eval("window.eveQaState")
            final = state["finals"][0] if len(state["finals"]) == 1 else None
            attempt = await desktop.send("read", final=final)
            after = await history(main)
            kept = all(after.get(key) == value for key, value in before.items())
            delta = list({key: value for key, value in after.items() if key not in before}.values())
            history_ok = kept and final and delta == [text_hash(final)]
            if label == "focus-safety":
                delivery_ok = (not attempt["insertions"] and attempt["clipboard_matches_final"]
                               and state["delivery"] == "copied_not_pasted")
                await main.eval("window.murmurMain.updateSetting('autoCopy',false)")
            else:
                delivery_ok = (len(attempt["insertions"]) == 1 and attempt["text"] == final
                               and attempt["clipboard_restored"])
        recovery = await recover(label)
        ok = history_ok and delivery_ok and delivered(recovery)
        save(label, "PASS" if ok else "FAIL", fault_insertions=len(attempt["insertions"]),
             recovery_insertions=recovery["insertion_count"], old_history_preserved=kept)

    async def end_fake_track():
        label = "mic-lost"
        injected = False
        try:
            async with app_session(root, install, quick, label=label) as (main, _, owner, _, _):
                before = await history(main)
                async with overlay_observer(main, install) as overlay:
                    await overlay.eval("""(() => {
                      const devices = navigator.mediaDevices;
                      const open = devices.getUserMedia.bind(devices);
                      devices.getUserMedia = async constraints => {
                        const stream = await open(constraints);
                        window.eveQaFakeTrack = stream.getAudioTracks()[0];
                        return stream;
                      };
                      return true;
                    })()""")
                    await desktop.send("reset")
                    await desktop.send("key", mode="quick")
                    await poll(lambda: overlay.eval("window.eveQaFakeTrack?.readyState"),
                               lambda state: state == "live", 8)
                    await asyncio.sleep(2)
                    injected = await overlay.eval("""(() => {
                      const track = window.eveQaFakeTrack;
                      track.stop();
                      track.dispatchEvent(new Event('ended'));
                      return track.readyState === 'ended';
                    })()""")
                if not injected:
                    raise FixtureUnavailable("fake-track-did-not-end")
                await poll(lambda: recording(main), lambda state: state["state"] == "idle", 35)
                await wait_health(owner["port"], "cpu", MODEL, 20)
                after = await history(main)
                attempt = await desktop.send("read")
                state = await main.eval("window.eveQaState")
                kept = all(after.get(key) == value for key, value in before.items())
            recovery = await recover(label)
            observed = (kept and len(after) - len(before) <= 1 and len(attempt["insertions"]) <= 1
                        and len(state["finals"]) <= 1 and delivered(recovery)
                        and recovery["history_before_sha256"] == history_digest(after))
            save(label, "PASS" if observed else "FAIL", track_ended=True,
                 fault_insertions=len(attempt["insertions"]), recovery_insertions=recovery["insertion_count"])
        except (FixtureUnavailable, TimeoutError, ConnectionClosed, RuntimeError) as error:
            save(label, "FAIL" if injected else "OPEN", observation=type(error).__name__,
                 track_ended=injected)

    silent_file = root / "silence.wav"
    with wave.open(str(silent_file), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", ""))
        wav.writeframes(b"\0" * 32000 * 6)
    for label, clip in (("silence", {**quick, "audio": silent_file}),
                        ("immediate-stop", quick), ("mic-unavailable", quick)):
        try:
            await microphone_scenario(label, clip, missing=label == "mic-unavailable")
        except (FixtureUnavailable, TimeoutError, ConnectionClosed, RuntimeError) as error:
            save(label, "OPEN", observation=type(error).__name__)

    await end_fake_track()
    for label in ("focus-safety", "busy"):
        try:
            await paste_safety(label)
        except (FixtureUnavailable, TimeoutError, ConnectionClosed, RuntimeError) as error:
            save(label, "OPEN", observation=type(error).__name__)

    # Use a task-private canary taken from the public reference. Both the
    # reference and the recognized five-word spans are scanned in memory.
    for trace in (False, True):
        label = "canary-on" if trace else "canary-off"
        try:
            async with app_session(root, install, quick, trace=trace, label=label) as session:
                main, process, _, stdout, stderr = session
                record, _ = await capture(main, process, desktop, stdout, quick, use_trace=trace)
                editor = await desktop.send("read")
                health_logs = await main.eval("window.murmurMain.getServerLogs()")
                logs = [stdout.read_text(encoding="utf-8", errors="replace"),
                        stderr.read_text(encoding="utf-8", errors="replace"),
                        json.dumps(health_logs, ensure_ascii=False)]
                words = normalize_text(editor["text"]).split()
                anchors = {" ".join(words[index:index + 5]) for index in range(len(words) - 4)}
                anchors.add(normalize_text(quick["reference"]))
                hits = sum(anchor in normalize_text(log) for anchor in anchors for log in logs)
                traced = any("B4_PERF" in log for log in logs)
                observed = delivered(record) and len(words) >= 5
                save(label, "OPEN" if not observed else "PASS" if hits == 0 and traced == trace else "FAIL",
                     matches=hits, trace_observed=traced, canary_inserted=observed)
        except (FixtureUnavailable, TimeoutError, ConnectionClosed, RuntimeError) as error:
            save(label, "OPEN", observation=type(error).__name__)

    for mode, phase in ((mode, phase) for mode in ("quick", "long") for phase in ("capture", "final")):
        label = f"crash-{mode}-{phase}"
        injected = False
        try:
            async with app_session(root, install, quick, label=label) as (main, process, owner, _, _):
                before = await history(main)
                await desktop.send("reset")
                await desktop.send("key", mode=mode)
                await poll(lambda: recording(main), lambda state: state["state"] in LISTENING, 5)
                if phase == "final":
                    await asyncio.sleep(2)
                    await desktop.send("key", mode=mode)
                    await poll(lambda: recording(main), lambda state: state["state"] == "processing", 3)
                kill_managed_server(process, owner)
                injected = True
                await poll(lambda: recording(main), lambda state: state["state"] == "idle", 15)
                after = await history(main)
                editor = await desktop.send("read")
                kept = all(after.get(key) == value for key, value in before.items())
            recovery = await recover(label)
            preserved = recovery["history_before_sha256"] == history_digest(after)
            ok = kept and preserved and len(editor["insertions"]) <= 1 and delivered(recovery)
            save(label, "PASS" if ok else "FAIL", history_before=len(before), history_after=len(after),
                 recovery_insertions=recovery["insertion_count"], fault_insertions=len(editor["insertions"]),
                 settled_history_preserved=preserved and kept)
        except (FixtureUnavailable, TimeoutError, ConnectionClosed, RuntimeError) as error:
            save(label, "FAIL" if injected else "OPEN", observation=type(error).__name__,
                 forced_exit_observed=injected)

    for phase in ("capture", "final"):
        label = f"cancel-{phase}"
        try:
            async with app_session(root, install, quick, label=label) as (main, _, _, _, _):
                before = await history(main)
                await desktop.send("reset")
                await desktop.send("key", mode="quick")
                await poll(lambda: recording(main), lambda state: state["state"] in LISTENING, 5)
                if phase == "final":
                    await asyncio.sleep(2)
                    await desktop.send("key", mode="quick")
                    await poll(lambda: recording(main), lambda state: state["state"] == "processing", 3)
                # Leaving the context requests graceful Browser.close, exercising
                # Eve's cancellation/quit disposition through relaunch.
            fault = await desktop.send("read")
            recovery = await recover(label)
            kept = recovery["history_before_sha256"] == history_digest(before)
            save(label, "PASS" if kept and not fault["insertions"] and delivered(recovery) else "FAIL",
                 history_before=len(before), fault_insertions=len(fault["insertions"]),
                 recovery_insertions=recovery["insertion_count"], settled_history_preserved=kept)
        except (FixtureUnavailable, TimeoutError, ConnectionClosed, RuntimeError) as error:
            save(label, "OPEN", observation=type(error).__name__)

    for label in ("socket-abort", "health-reload", "model-unavailable"):
        try:
            missing = label == "model-unavailable"
            async with app_session(root, install, quick, label=label, wait_for_model=not missing,
                                   offline_cache=root / "missing-model" if missing else None
                                   ) as (main, _, owner, _, _):
                port = owner["port"]
                before = await history(main)
                if label == "socket-abort":
                    facts = await abrupt_socket(port, root / "runtime-temp")
                    ok = facts["scratch_entries_unchanged"] and psutil.pid_exists(owner["pid"])
                elif missing:
                    await poll(lambda port=port: http(port, "/health"), lambda health: health and
                               health.get("engine", {}).get("status") == "error", 45)
                    await desktop.send("reset")
                    await desktop.send("key", mode="quick")
                    await poll(lambda: recording(main), lambda state: not state["isRecording"], 10)
                    await asyncio.sleep(1)
                    after = await history(main)
                    editor = await desktop.send("read")
                    ok = before == after and not editor["insertions"]
                    facts = {"offline_empty_cache": True, "fault_insertions": len(editor["insertions"])}
                else:
                    for model in ("tiny", MODEL):
                        response = await main.eval(
                            f"window.murmurMain.updateServerSettings({json.dumps({'whisper_model': model})})"
                        )
                        if not response:
                            raise FixtureUnavailable("settings-save-unobserved")
                        await wait_health(port, "cpu", model, 720)
                    ok = True
                    facts = {"startup_healthy": True, "reload_ready_count": 2}
            recovery = await recover(label)
            kept = recovery["history_before_sha256"] == history_digest(before)
            save(label, "PASS" if ok and kept and delivered(recovery) else "FAIL",
                 recovery_insertions=recovery["insertion_count"], settled_history_preserved=kept, **facts)
        except (FixtureUnavailable, TimeoutError, ConnectionClosed, RuntimeError) as error:
            save(label, "OPEN", observation=type(error).__name__)


async def hosted_replay(root, install, clips, evidence, output, audit):
    server = install / "resources/server"
    env = runtime_environment(root)
    pid_file = root / "replay.pid"
    env.update({
        "PYTHONPATH": str(server / ".venv/Lib/site-packages"), "PYTHONUTF8": "1",
        "MURMUR_APP_BUILD_ID": "0.9.0-beta.1",
        "MURMUR_HOST": "127.0.0.1", "MURMUR_PORT": "0",
        "MURMUR_PID_FILE": str(pid_file), "MURMUR_SETTINGS_FILE": str(root / "replay-settings.json"),
        "MURMUR_WHISPER_MODEL": MODEL,
    })
    evidence["method"] = "retained-cpu-replay"
    write_evidence(output, evidence)
    process = start_process([str(server / ".runtime/python.exe"), str(server / "src/main.py")],
                            server, env, root / "replay.out.log", root / "replay.err.log")
    try:
        async def replay_owner():
            exit_code = process.poll()
            if exit_code is not None:
                evidence["replay_startup_exit_code"] = exit_code
                write_evidence(output, evidence)
                raise FixtureUnavailable("bundled-replay-server-exited")
            return json.loads(pid_file.read_text(encoding="utf-8")) if pid_file.exists() else None

        owner = await poll(replay_owner, bool, 30)
        if owner["pid"] != process.pid:
            raise FixtureUnavailable("replay-server-pid-mismatch")
        await wait_health(owner["port"], "cpu", MODEL, 720)
        await run_replay(owner["port"], owner["pid"], clips, evidence, output, audit)
    finally:
        stop_owned_tree(process)


async def observe_warmup(root, install, desktop, clip, evidence, output, label, control_key):
    async with app_session(root, install, clip, label=label) as (main, process, _, log, _):
        await desktop.send("reset")
        probe = await desktop.send("probe-paste")
        await asyncio.sleep(.3)
        control = await desktop.send("read")
        evidence[control_key] = (
            probe and len(control["insertions"]) == 1 and control["clipboard_restored"]
            and text_hash(control["text"]) == text_hash("EVE QA CLIPBOARD SEED")
        )
        write_evidence(output, evidence)
        record, _ = await capture(main, process, desktop, log, clip)
        return record


def validate_warmup_capture(record):
    if record["final_count"] != 1 or record["empty"] or not record["history_correct"]:
        raise FixtureUnavailable("warmup-packaged-capture-unavailable")


def smoke_delivery_issue(record, native_control):
    if record["failed"] or not record["insert_matches_final"]:
        if not native_control:
            return "warmup-native-editor-control-unobserved"
        if record["delivery"] == "paste_skipped" and not record["paste_helper_request_observed"]:
            return "warmup-paste-skipped-before-helper"
        return "warmup-editor-insertion-unobserved"
    if not record["clipboard_restored"]:
        return "warmup-clipboard-not-restored"
    if record["stop_to_insert_ms"] is None:
        if record["editor_stop_key_observed"]:
            return "warmup-editor-insertion-timing-unobserved"
        return "warmup-editor-stop-key-unobserved"
    return None


async def run(args):
    root, install = args.root.resolve(), args.install.resolve()
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    if (root == runner_temp or not root.is_relative_to(runner_temp)
            or install == root or not install.is_relative_to(root)):
        raise FixtureUnavailable("invalid-hosted-scratch")
    (root / "runtime-temp").mkdir()
    clips = load_clips(args.manifest, args.config, smoke=args.smoke)
    audit = None
    if args.entity_audit and not args.smoke:
        from scripts.sim_acceptance.entity_audit import EntityAudit

        audit = EntityAudit(args.entity_audit, args.config, CANDIDATE)
    evidence = {
        "candidate": CANDIDATE, "config": args.config, "method": "packaged-editor",
        "model": MODEL, "device": "cpu", "trials": [], "resources": {},
        "robustness": {}, "hosted_run_id": os.environ["GITHUB_RUN_ID"],
        "harness_commit": os.environ["GITHUB_SHA"], "smoke_only": args.smoke,
        "corpus_manifest_sha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
    }
    write_evidence(args.output, evidence)
    editor_process = await asyncio.create_subprocess_exec(
        sys.executable, str(HERE / "desktop.py"), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, creationflags=NO_WINDOW,
    )
    desktop = Desktop(editor_process)
    try:
        interrupted_bytes = None
        if args.config == "close-quiet" and not args.smoke:
            try:
                interrupted_bytes = await interrupt_download(root, install, clips[0])
            except (FixtureUnavailable, TimeoutError, ConnectionClosed, RuntimeError) as error:
                evidence["robustness"]["tls-retry"] = {
                    "status": "OPEN", "observation": type(error).__name__,
                }
                write_evidence(args.output, evidence)
        try:
            native_control = "runner_editor_control_paste_observed"
            warmup = await observe_warmup(root, install, desktop, clips[0], evidence,
                                          args.output, "warmup", native_control)
            evidence["warmup"] = warmup
            write_evidence(args.output, evidence)
            validate_warmup_capture(warmup)
            if args.smoke:
                issue = smoke_delivery_issue(warmup, evidence[native_control])
                if issue == "warmup-paste-skipped-before-helper":
                    print(f"Hosted smoke [{issue}]. Rechecking after one relaunch.", flush=True)
                    retry_control = "smoke_retry_control_paste_observed"
                    retry = await observe_warmup(root, install, desktop, clips[0], evidence,
                                                 args.output, "smoke-relaunch", retry_control)
                    evidence["smoke_retry"] = retry
                    write_evidence(args.output, evidence)
                    validate_warmup_capture(retry)
                    issue = smoke_delivery_issue(retry, evidence[retry_control])
                if issue is not None:
                    raise FixtureUnavailable(issue)
            if interrupted_bytes and not warmup["failed"]:
                evidence["robustness"]["tls-retry"] = {
                    "status": "PASS",
                    "method": "process interrupted during HTTPS model preparation",
                    "bytes_received_before_interrupt": interrupted_bytes,
                    "recovery_insertions": warmup["insertion_count"],
                }
                write_evidence(args.output, evidence)
        except (FixtureUnavailable, TimeoutError, ConnectionClosed) as error:
            reason = fixture_reason(error)
            evidence["app_fixture_gap"] = reason
            write_evidence(args.output, evidence)
            if args.smoke:
                raise
            print(f"Packaged editor fixture unavailable [{reason}]. Running bundled replay.", flush=True)
            await hosted_replay(root, install, clips, evidence, args.output, audit)
            return
        if args.smoke:
            return
        for clip in clips:
            try:
                async with app_session(root, install, clip) as (main, process, _, log, _):
                    trial, resources = await capture(main, process, desktop, log, clip,
                                                     time_idle=clip["mode"] == "long", audit=audit)
                    evidence["resources"].update(resources)
            except (FixtureUnavailable, TimeoutError, ConnectionClosed) as error:
                reason = fixture_reason(error)
                print(f"{args.config} {clip['id']}: fixture unavailable [{reason}]", flush=True)
                trial = trial_record(clip, None, output_observed=False, failed=True, fixture_gap=reason)
            evidence["trials"].append(trial)
            write_evidence(args.output, evidence)
            print(f"{args.config} {clip['id']}: observed={trial['output_observed']}", flush=True)
        if args.config == "close-quiet":
            observed = [evidence["warmup"], *evidence["trials"]]
            complete = all("history_before_sha256" in row for row in observed)
            if complete:
                contiguous = all(before["history_after_sha256"] == after["history_before_sha256"]
                                 for before, after in pairwise(observed))
                evidence["robustness"]["history"] = {
                    "status": "PASS" if contiguous and all(row["history_correct"] for row in observed) else "FAIL",
                    "observed_launches": len(observed),
                }
                write_evidence(args.output, evidence)
            await robustness(root, install, desktop, clips[0], evidence, args.output)
    finally:
        if editor_process.returncode is None:
            editor_process.kill()
        await editor_process.wait()


def main():
    if (os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or os.environ.get("GITHUB_EVENT_NAME") not in {"workflow_dispatch", "pull_request"}
            or os.environ.get("GITHUB_REPOSITORY") != "burntcookiedough/eve-windows-dictation"):
        raise SystemExit("Packaged acceptance requires the repository's disposable hosted Windows runner")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--install", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--entity-audit", type=Path)
    try:
        asyncio.run(run(parser.parse_args()))
    except Exception as error:  # noqa: BLE001 - raw exceptions may disclose speech or machine paths
        # Raw errors can contain path, transport payload or transcript data.
        print(f"Packaged acceptance stopped [{fixture_reason(error)}].", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
