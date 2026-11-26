"""Score simulated acceptance observations and render the frozen gate table."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

from rapidfuzz.distance import Levenshtein

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.validation_harness import normalize_text

CONFIGS = ("far-quiet", "far-moderate", "close-moderate", "close-quiet", "gpu-close-quiet")
CANDIDATE = {
    "run_id": "45784796424",
    "artifact_id": "15101085356",
    "commit": "22aa01d70a10fc8b52668866ff1c0bd5ac02c751",
    "manifest_sha256": "e0004b05ee119467a037c201ea723159e01adda3615f5a2668cfb05433fe763f",
}


def text_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_clips(path, config, *, smoke=False):
    path = path.resolve()
    data = json.loads(path.read_text(encoding="utf-8"))
    clips = [row for row in data["clips"] if row["config"] == config]
    expected = {"Q01"} if smoke else {f"Q{i:02}" for i in range(1, 21)} | {"L01"}
    if {row["id"] for row in clips} != expected:
        raise ValueError("Missing declared corpus trials")
    if len(clips) != len(expected):
        raise ValueError("Duplicate declared corpus trials")
    for clip in clips:
        name = f"{config}-{clip['id']}.wav"
        if clip["path"] != name:
            raise ValueError("Unexpected corpus path")
        clip["audio"] = path.parent / name
        with clip["audio"].open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != clip["sha256"]:
                raise ValueError("Corpus WAV SHA-256 differs from the manifest")
    return sorted(clips, key=lambda row: (row["mode"] == "long", row["id"]))


def score_text(clip, hypothesis):
    reference = normalize_text(clip["reference"]).split()
    expected = {"reference_words": len(reference), "entities_expected": len(clip["entities"])}
    chunks = clip.get("chunks", [])
    if hypothesis is None:
        return {**expected, "chunks_expected": len(chunks)}
    actual = normalize_text(hypothesis).split()
    matches = {}
    for opcode in Levenshtein.opcodes(reference, actual):
        if opcode.tag == "equal":
            matches.update(zip(range(opcode.src_start, opcode.src_end),
                               range(opcode.dest_start, opcode.dest_end)))
    entities_exact = sum(
        all(word in matches and (word == start or matches[word] == matches[word - 1] + 1)
            for word in range(start, end))
        for start, end, _ in clip["entities"]
    )
    # Flag a chunk if fewer than half its words align, or if only one
    # word of a multiword chunk survives. This is a transcript heuristic.
    missing = 0
    for start, end in chunks:
        length = end - start
        aligned = sum(word in matches for word in range(start, end))
        missing += aligned < min(length, max(2, math.ceil(length / 2)))
    anchors = {tuple(reference[start:end]) for start, end in chunks if end > start}
    lengths = {len(anchor) for anchor in anchors}

    def occurrences(words):
        return Counter(
            phrase for length in lengths for offset in range(len(words) - length + 1)
            if (phrase := tuple(words[offset:offset + length])) in anchors
        )

    # Also catch exact repeats absorbed into alignment replacements. Compare
    # against all reference occurrences so existing repetitions are expected.
    duplicated = (occurrences(actual) - occurrences(reference)).total()
    return {
        **expected, "word_errors": Levenshtein.distance(reference, actual),
        "entities_exact": entities_exact, "chunks_expected": len(chunks),
        "chunk_heuristic_missing": missing, "chunk_heuristic_repeated": duplicated,
        "output_sha256": text_hash(hypothesis), "empty": not actual,
    }


def trial_record(clip, hypothesis, **fields):
    return {
        "id": clip["id"], "mode": clip["mode"], "audio_sha256": clip["sha256"],
        "duration_s": clip["duration_s"], **score_text(clip, hypothesis), **fields,
    }


def write_evidence(path, evidence):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(evidence, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temp.replace(path)


def nearest_rank(values, quantile):
    return sorted(values)[math.ceil(len(values) * quantile) - 1] if values else None


def outcome(condition, complete):
    return "FAIL" if not condition else "PASS" if complete else "OPEN"


def ratio(rows, hits, total, *, empty_score, unit):
    present = []
    for row in rows:
        if total not in row:
            continue
        if row.get("output_observed") and row.get("empty"):
            present.append((empty_score(row), row[total]))
        elif row.get(hits) is not None:
            present.append((row[hits], row[total]))
    numerator = sum(value for value, _ in present)
    denominator = sum(count for _, count in present)
    attempted_total = sum(row.get(total, 0) for row in rows)
    known_total = sum(total in row for row in rows) == len(rows)
    attempted_label = str(attempted_total) if known_total else f"≥{attempted_total}"
    details = (f"{numerator}/{denominator}, n={len(present)} scored, "
               f"{len(rows)} attempted, {attempted_label} attempted {unit}")
    return numerator, denominator, len(present), attempted_total if known_total else None, details


def rate(numerator, denominator):
    return 100 * numerator / denominator if denominator else None


def percentile_status(values, expected, targets):
    missing = expected - len(values)
    lower = [nearest_rank([*values, *([0] * missing)], q) for q, _ in targets]
    upper = [nearest_rank([*values, *([math.inf] * missing)], q) for q, _ in targets]
    if any(value > limit for value, (_, limit) in zip(lower, targets)):
        return "FAIL"
    if all(value <= limit for value, (_, limit) in zip(upper, targets)):
        return "PASS"
    return "OPEN"


def fmt(value):
    return "unobserved" if value is None else f"{value:.3f}"


def assess(config, evidence):
    gpu = config.startswith("gpu-")
    noisy = config.endswith("-moderate")
    rows = evidence.get("trials", [])
    quick = [row for row in rows if row["mode"] == "quick"]
    long = [row for row in rows if row["mode"] == "long"]
    known_ids = {f"Q{i:02}" for i in range(1, 21)} | {"L01"}
    if (len({row["id"] for row in rows}) != len(rows)
            or any(row["id"] not in known_ids or row["mode"] not in {"quick", "long"} or
                   (row["id"] == "L01") != (row["mode"] == "long") for row in rows)):
        raise ValueError("Duplicate or undeclared trial observation")
    if any(row["id"] == "L01" and row["duration_s"] != 1800 for row in long):
        raise ValueError("Long fixture duration differs from 30 minutes")
    observations = []

    def add(metric, limit, observed, status):
        observations.append((config, metric, limit, observed, status))

    inserted = [row for row in rows if row.get("insertion_count") is not None]
    bad_insertion = sum(row["insertion_count"] != 1 or not row.get("insert_matches_final")
                        for row in inserted)
    restored = [row["clipboard_restored"] for row in inserted if "clipboard_restored" in row]
    add("Insertion / clipboard", "Exactly once, 0 lost, 0 duplicates, 100% restored",
        f"bad inserts {bad_insertion}/{len(inserted)}, restored {sum(restored)}/{len(restored)}",
        outcome(bad_insertion == 0 and all(restored), len(inserted) == len(restored) == 21))

    for mode, group, expected, bad_limit, wer_limit in (
        ("Quick", quick, 20, 1, 18 if noisy else 12),
        ("Long", long, 1, 0, 20 if noisy else 15),
    ):
        result_rows = [row for row in group if row.get("output_observed") or row.get("failed")]
        bad = sum(row.get("empty", False) or row.get("failed", False) for row in result_rows)
        add(f"{mode} empty/failed", f"≤ {bad_limit}/{expected}",
            f"{bad}/{len(result_rows)} observed, {len(group)} attempted",
            outcome(bad <= bad_limit, len(result_rows) == expected))
        errors, words, n, attempted_words, fraction = ratio(
            group, "word_errors", "reference_words",
            empty_score=lambda row: row["reference_words"], unit="reference words",
        )
        wer = rate(errors, words)
        minimum_wer = rate(errors, attempted_words) if len(group) == expected else None
        add(f"{mode} WER", f"≤ {wer_limit}%", f"{fmt(wer)}% ({fraction})",
            outcome(minimum_wer is None or minimum_wer <= wer_limit, n == expected and wer is not None))

    add("Long chunks", "0 dropped, 0 duplicated", "Chunk sequence verification unobserved", "OPEN")

    def entity_ratio(group):
        return ratio(group, "entities_exact", "entities_expected", empty_score=lambda _: 0, unit="entities")

    exact, entities, _, attempted_entities, fraction = entity_ratio(rows)
    pct = rate(exact, entities)
    entity_status = "OPEN"
    if len(rows) == 21 and attempted_entities:
        if rate(exact + attempted_entities - entities, attempted_entities) < 85:
            entity_status = "FAIL"
        elif rate(exact, attempted_entities) >= 85:
            entity_status = "PASS"
    add("Names / numbers / terms", "≥ 85% exact",
        f"{fmt(pct)}% ({fraction}), Quick {entity_ratio(quick)[-1]}, Long {entity_ratio(long)[-1]}",
        entity_status)

    def latency(group):
        return [row["stop_to_insert_ms"] for row in group if row.get("stop_to_insert_ms") is not None]

    quick_limit = (800, 1500) if gpu else (1500, 3000)
    long_limit = 20_000 if gpu else 90_000
    quick_values, long_values = latency(quick), latency(long)
    p50, p95 = (nearest_rank(quick_values, q) for q in (.5, .95))
    qlabel = (f"editor p50 {fmt(p50)} ms, p95 {fmt(p95)} ms, "
              f"n={len(quick_values)}/20, {len(quick)} attempted")
    llabel = f"editor {fmt(max(long_values, default=None))} ms, n={len(long_values)}/1, {len(long)} attempted"
    add("Quick stop → insert", f"p50 ≤ {quick_limit[0]} ms, p95 ≤ {quick_limit[1]} ms", qlabel,
        percentile_status(quick_values, 20, tuple(zip((.5, .95), quick_limit))))
    add("Long finalization", f"≤ {long_limit} ms", llabel,
        outcome(all(value <= long_limit for value in long_values), len(long_values) == 1))

    resources = evidence.get("resources", {})
    for key, label, limit, units, strict in (
        ("idle_rss_gib", "Idle RSS", 1.5, "GiB", False),
        ("long_peak_rss_gib", "Long peak RSS", 2.5, "GiB", False),
        ("long_rss_growth_pct", "Long RSS growth, minute 5 → 30", 15, "%", False),
        ("idle_cpu_pct", "Idle CPU over 120 seconds", 2, "%", True),
    ):
        value = resources.get(key)
        passes = value is None or (value < limit if strict else value <= limit)
        scope = "server only" if evidence.get("method", "").endswith("replay") else "app + server"
        complete = scope == "app + server" and value is not None
        window = "long" if key.startswith("long") else "idle"
        detail = f"n={resources.get(f'{window}_sample_count', 0)}"
        if key == "idle_cpu_pct":
            detail += f", {fmt(resources.get('idle_cpu_valid_s'))} valid seconds"
            complete = (complete and (resources.get("idle_cpu_valid_s") or 0) >= 120
                        and resources.get("idle_rss_window_covered") is not False)
        else:
            covered = resources.get(f"{window}_rss_window_covered") is True
            detail += ", window covered" if covered else ", window coverage unverified"
            if resources.get(f"{window}_sample_errors"):
                detail += f", {resources[f'{window}_sample_errors']} sample errors"
            complete = complete and covered
        # Only absolute RSS provides a lower bound if the required coverage is missing.
        comparable = key in {"idle_rss_gib", "long_peak_rss_gib"} or complete
        add(label, f"{'<' if strict else '≤'} {limit} {units}",
            f"{fmt(value)} {units} ({scope}, {detail})",
            outcome(passes if comparable else True, complete))
    return observations


ROBUSTNESS = (
    ("canary-off", "G3", "Canary omitted from logs with tracing off"),
    ("canary-on", "G3", "Canary omitted from logs with tracing on"),
    ("mic-unavailable", "G4", "Unavailable device and next Quick"),
    ("mic-lost", "G4", "Lost fake track and next Quick"),
    ("silence", "G4", "Silence produces no insertion"),
    ("immediate-stop", "G4", "Immediate stop and next Quick"),
    ("crash-quick-capture", "G5", "Managed server dies during Quick capture"),
    ("crash-quick-final", "G5", "Managed server dies during Quick finalization"),
    ("crash-long-capture", "G5", "Managed server dies during Long capture"),
    ("crash-long-final", "G5", "Managed server dies during Long finalization"),
    ("socket-abort", "G5", "Abrupt WebSocket disconnect, cleanup and reconnect"),
    ("tls-retry", "G6", "Interrupted HTTPS model download and retry"),
    ("model-unavailable", "G6", "Missing or corrupt model cache and recovery"),
    ("health-reload", "G6", "Startup health, settings save and model reload"),
    ("cancel-capture", "G7", "Cancel during capture and next Quick"),
    ("cancel-final", "G7", "Cancel during finalization and next Quick"),
    ("focus-safety", "G7", "Vanished original editor receives no paste"),
    ("busy", "G7", "Busy stop boundary produces only one final"),
    ("history", "G7", "History preserved across failures and relaunch"),
)
GPU_PACK = ("install", "interrupt", "corrupt", "wrong-version", "repair", "remove", "cpu-fallback")
CANCELLATION_FAILURE_PATHS = {"forced-after-timeout", "force-stop-unverified", "nonzero-exit"}


def supplemental_observations(by_config, overhead):
    chunks = []
    replay = []
    for config in CONFIGS:
        trials = by_config.get(config, {}).get("trials", [])
        long = next((row for row in trials if row["mode"] == "long"), {})
        for keys, method in (
            (("chunk_heuristic_missing", "chunk_heuristic_repeated"), "Transcript alignment"),
            (("chunks_missing", "chunks_repeated"), "Legacy transcript alignment"),
        ):
            if all(key in long for key in keys):
                missing, repeated = (long[key] for key in keys)
                chunks.append(f"| {config} | {method} | {long['chunks_expected']} | {missing} | {repeated} |")
                break

        for mode, extra in zip(("quick", "long"), overhead):
            values = [row["stop_to_final_ms"] for row in trials
                      if row["mode"] == mode and row.get("stop_to_final_ms") is not None]
            if not values:
                continue
            quantiles = (.5, .95) if mode == "quick" else (1,)
            summary = " / ".join(fmt(nearest_rank(values, q)) for q in quantiles)
            estimate = "unobserved"
            if config == "gpu-close-quiet" and extra is not None:
                estimate = " / ".join(fmt(nearest_rank(values, q) + extra) for q in quantiles)
            replay.append(f"| {config} | {mode.title()} | {len(values)} | {summary} | {estimate} |")

    out = []
    if chunks:
        out.extend(("", "## Long transcript heuristic", "",
                    "| Config | Method | Expected chunks | Suspected missing | Exact excess matches |",
                    "|---|---|---:|---:|---:|", *chunks))
    if replay:
        out.extend(("", "## Replay timing", "",
                    ("Quick reports p50 / p95. Long reports the observed duration. "
                     "The GPU proxy adds the largest observed hosted close/quiet insertion duration "
                     f"for each mode. Quick {fmt(overhead[0])} ms. Long {fmt(overhead[1])} ms."),
                    "", "| Config | Mode | Samples | Stop → final (ms) | GPU proxy (ms) |",
                    "|---|---|---:|---:|---:|", *replay))
    return out


def render(all_evidence, lifecycle, history):
    by_config = {item["config"]: item for item in all_evidence if item.get("config")}
    if len(by_config) != len([item for item in all_evidence if item.get("config")]):
        raise ValueError("More than one evidence file for a configuration")
    if any(item.get("candidate") != CANDIDATE for item in all_evidence):
        raise ValueError("Every evidence file must identify the verified candidate")
    measurements = by_config.get("close-quiet", {}).get("trials", [])
    overhead = tuple(
        max((row["observed_insert_overhead_ms"] for row in measurements
             if row["mode"] == mode and row.get("observed_insert_overhead_ms") is not None),
            default=None)
        for mode in ("quick", "long")
    )
    tests = [row for name in CONFIGS for row in assess(name, by_config.get(name, {}))]
    scenarios = {}
    for item in all_evidence:
        for key, value in item.get("robustness", {}).items():
            if key in scenarios:
                raise ValueError("Duplicate robustness observation")
            scenarios[key] = value
    for key, gate, label in ROBUSTNESS:
        details = scenarios.get(key, {})
        result = details.get("status", "OPEN")
        facts = ", ".join(f"{name.replace('_', ' ')} = {value}"
                          for name, value in details.items() if name != "status")
        if key.startswith("canary-") and details.get("matches", 0) > 0:
            result = "FAIL"
        if key == "immediate-stop" and result == "PASS" and not details.get("stop_in_window"):
            result = "OPEN"
            facts += (", " if facts else "") + "immediate stop unverified"
        if key in {"cancel-capture", "cancel-final"}:
            path = details.get("exit_path")
            injected = details.get("cancellation_phase_reached") and details.get("close_request_sent")
            if injected and path in CANCELLATION_FAILURE_PATHS:
                result = "FAIL"
            elif result == "PASS" and not (injected and path == "graceful"):
                result = "OPEN"
                facts += (", " if facts else "") + "graceful exit unverified"
        tests.append((gate, label, "Scripted result, clean recovery and no lost History",
                      facts or "unobserved", result))
    for key in GPU_PACK:
        tests.append(("G9", f"GPU pack {key}", "Pass", key,
                      scenarios.get(f"gpu-pack-{key}", {}).get("status", "OPEN")))
    tests.append(("G2", "Hosted lifecycle and retained History", "Both pass on final candidate",
                  f"Lifecycle {lifecycle or 'unverified'}, History {history or 'unverified'}",
                  "PASS" if lifecycle and history else "OPEN"))
    statuses = Counter(row[-1] for row in tests)
    out = [
        "# Eve 0.9.0-beta.1 simulated acceptance", "",
        f"**{statuses['PASS']} pass · {statuses['FAIL']} fail · {statuses['OPEN']} open**", "",
        (f"Candidate commit `{CANDIDATE['commit']}`, retained run {CANDIDATE['run_id']}, "
         f"artifact {CANDIDATE['artifact_id']}. Manifest SHA-256 `{CANDIDATE['manifest_sha256']}`."),
        "",
        "| Config or gate | Metric | Frozen limit | Observed | Result |",
        "|---|---|---|---|---|",
    ]
    out.extend("| " + " | ".join(row) + " |" for row in tests)
    out.extend(supplemental_observations(by_config, overhead))
    return "\n".join(out) + "\n", statuses


def verify_history(run_id, artifact, metadata_path):
    metadata = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
    workflow_run = metadata.get("workflow_run") or {}
    if (not re.fullmatch(r"[1-9][0-9]*", run_id)
            or str(workflow_run.get("id")) != run_id
            or metadata.get("name") != f"eve-retained-history-evidence-{run_id}"):
        raise ValueError("History artifact does not match the requested workflow run and archive digest")
    with artifact.open("rb") as source:
        archive_digest = hashlib.file_digest(source, "sha256").hexdigest()
        if (metadata.get("size_in_bytes") != source.seek(0, 2)
                or metadata.get("digest") != f"sha256:{archive_digest}"):
            raise ValueError("History artifact does not match its metadata size and digest")
        with zipfile.ZipFile(source) as archive:
            member = "functional-history-evidence.json"
            if archive.namelist().count(member) != 1:
                raise ValueError("History artifact must contain one gate evidence file")
            gate = json.loads(archive.read(member).decode("utf-8-sig"))
    source = gate["candidateSource"]
    if (gate["overallStatus"] != "passed" or source["runId"] != CANDIDATE["run_id"]
            or source["artifactId"] != CANDIDATE["artifact_id"]
            or gate["candidateCommit"] != CANDIDATE["commit"]
            or gate["manifestSha256"] != CANDIDATE["manifest_sha256"]):
        raise ValueError("History evidence does not show a passing gate on the retained candidate")
    return run_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--lifecycle-run")
    parser.add_argument("--history-run")
    parser.add_argument("--history-evidence", type=Path, help="Original retained History artifact ZIP")
    parser.add_argument("--history-metadata", type=Path, help="GitHub API metadata for the ZIP")
    args = parser.parse_args()
    if args.lifecycle_run and args.lifecycle_run != CANDIDATE["run_id"]:
        raise ValueError("Lifecycle run must match the candidate")
    history_inputs = (args.history_run, args.history_evidence, args.history_metadata)
    if any(history_inputs) and not all(history_inputs):
        raise ValueError("History run, downloaded ZIP, and artifact metadata are required together")
    history = verify_history(*history_inputs) if all(history_inputs) else None
    evidence = [json.loads(path.read_text(encoding="utf-8-sig")) for path in args.files]
    markdown, statuses = render(evidence, args.lifecycle_run, history)
    args.output.write_text(markdown, encoding="utf-8")
    return 1 if statuses["FAIL"] else 2 if statuses["OPEN"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
