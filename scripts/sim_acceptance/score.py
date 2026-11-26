"""Score simulated acceptance observations and render the frozen gate table."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
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
    inserted = []
    for opcode in Levenshtein.opcodes(reference, actual):
        if opcode.tag == "equal":
            matches.update(zip(range(opcode.src_start, opcode.src_end),
                               range(opcode.dest_start, opcode.dest_end)))
        if opcode.tag == "insert":
            inserted.append(actual[opcode.dest_start:opcode.dest_end])
    entities_exact = sum(
        all(word in matches and (word == start or matches[word] == matches[word - 1] + 1)
            for word in range(start, end))
        for start, end, _ in clip["entities"]
    )
    # Each LibriSpeech utterance is an annotated chunk. A compatible normalized
    # word proves some of the aligned chunk survived. Count exact repeated
    # passages in insertion spans and expose the detection limits in the report.
    missing = sum(not any(word in matches for word in range(start, end))
                  for start, end in chunks)
    anchors = {tuple(reference[start:end]) for start, end in chunks if end - start >= 5}
    lengths = {len(anchor) for anchor in anchors}
    duplicated = sum(
        tuple(words[offset:offset + length]) in anchors
        for words in inserted for length in lengths
        for offset in range(len(words) - length + 1)
    )
    return {
        **expected, "word_errors": Levenshtein.distance(reference, actual),
        "entities_exact": entities_exact, "chunks_expected": len(chunks),
        "chunks_missing": missing, "chunks_repeated": duplicated,
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


def ratio(rows, hits, total):
    present = [row for row in rows if hits in row and total in row]
    numerator = sum(row[hits] for row in present)
    denominator = sum(row[total] for row in present)
    return (100 * numerator / denominator if denominator else None,
            f"{numerator}/{denominator}, n={len(present)}", len(present))


def fmt(value):
    return "unobserved" if value is None else f"{value:.3f}"


def assess(config, evidence, hosted_overhead):
    gpu = config.startswith("gpu-")
    noisy = config.endswith("-moderate")
    rows = evidence.get("trials", [])
    quick = [row for row in rows if row["mode"] == "quick"]
    long = [row for row in rows if row["mode"] == "long"]
    known_ids = {f"Q{i:02}" for i in range(1, 21)} | {"L01"}
    if (len({row["id"] for row in rows}) != len(rows)
            or any(row["id"] not in known_ids or
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
        result_rows = [row for row in group if row.get("output_observed")]
        bad = sum(row.get("empty", False) or row.get("failed", False) for row in result_rows)
        add(f"{mode} empty/failed", f"≤ {bad_limit}/{expected}",
            f"{bad}/{len(result_rows)} observed, {len(group)} attempted",
            outcome(bad <= bad_limit, len(result_rows) == expected))
        wer, fraction, n = ratio(group, "word_errors", "reference_words")
        add(f"{mode} WER", f"≤ {wer_limit}%", f"{fmt(wer)}% ({fraction})",
            outcome(wer is None or wer <= wer_limit, n == expected))

    if long and "chunks_missing" in long[0]:
        chunk = long[0]
        missing, repeated = chunk["chunks_missing"], chunk["chunks_repeated"]
        add("Long chunks", "0 dropped, 0 duplicated",
            f"{missing} missing, {repeated} repeated, {chunk['chunks_expected']} expected",
            outcome(missing == repeated == 0, chunk["chunks_expected"] > 0))
    else:
        add("Long chunks", "0 dropped, 0 duplicated", "unobserved", "OPEN")

    pct, fraction, n = ratio(rows, "entities_exact", "entities_expected")
    quick_entities = ratio(quick, "entities_exact", "entities_expected")[1]
    long_entities = ratio(long, "entities_exact", "entities_expected")[1]
    add("Names / numbers / terms", "≥ 85% exact",
        f"{fmt(pct)}% ({fraction}), Quick {quick_entities}, Long {long_entities}",
        outcome(pct is None or pct >= 85, n == 21 and pct is not None))

    def latency(group):
        return [row["stop_to_insert_ms"] for row in group if row.get("stop_to_insert_ms") is not None]

    def replay_latency(group):
        return [row["stop_to_final_ms"] for row in group if row.get("stop_to_final_ms") is not None]

    quick_limit = (800, 1500) if gpu else (1500, 3000)
    long_limit = 20_000 if gpu else 90_000
    quick_values, long_values = latency(quick), latency(long)
    method = "editor"
    replay_quick, replay_long = replay_latency(quick), replay_latency(long)
    if gpu:
        method = "GPU replay + hosted insertion estimate"
        quick_values = [value + hosted_overhead[0] for value in replay_quick
                        if hosted_overhead[0] is not None]
        long_values = [value + hosted_overhead[1] for value in replay_long
                       if hosted_overhead[1] is not None]
    p50, p95 = (nearest_rank(quick_values, q) for q in (.5, .95))
    qlabel = f"{method} p50 {fmt(p50)} ms, p95 {fmt(p95)} ms, n={len(quick_values)}"
    llabel = f"{method} {fmt(max(long_values, default=None))} ms, n={len(long_values)}"
    if replay_quick:
        qlabel += (
            f"; replay final p50 {fmt(nearest_rank(replay_quick, .5))} ms, "
            f"p95 {fmt(nearest_rank(replay_quick, .95))} ms, n={len(replay_quick)}"
        )
    if replay_long:
        llabel += f"; replay final {fmt(max(replay_long))} ms, n={len(replay_long)}"
    # A replay can expose a timing miss by itself. A passing proxy still
    # leaves true editor latency open because the GPU app was never exercised.
    q_lower = () if quick_values or not gpu else tuple(nearest_rank(replay_quick, q) for q in (.5, .95))
    q_compare = (p50, p95) if quick_values else q_lower
    add("Quick stop → insert", f"p50 ≤ {quick_limit[0]} ms, p95 ≤ {quick_limit[1]} ms", qlabel,
        outcome(all(value is None or value <= limit for value, limit in zip(q_compare, quick_limit)),
                len(quick_values) == 20 and not gpu))
    l_compare = long_values or (replay_long if gpu else [])
    add("Long finalization", f"≤ {long_limit} ms", llabel,
        outcome(all(value <= long_limit for value in l_compare), len(long_values) == 1 and not gpu))

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
        sample_key = "long_sample_count" if key.startswith("long") else "idle_sample_count"
        detail = f"n={resources.get(sample_key, 0)}"
        if key == "idle_cpu_pct":
            detail += f", {fmt(resources.get('idle_cpu_valid_s'))} valid seconds"
        # Server RSS and idle CPU are lower bounds for app + server. Growth
        # percentages are different when the app footprint is unobserved.
        comparable = key != "long_rss_growth_pct" or complete
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
    tests = [row for name in CONFIGS for row in assess(name, by_config.get(name, {}), overhead)]
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
        ("GPU insertion estimate uses the largest observed close/quiet app-side duration "
         f"for each mode when available. Quick {fmt(overhead[0])} ms. Long {fmt(overhead[1])} ms."),
        "",
        "| Config or gate | Metric | Frozen limit | Observed | Result |",
        "|---|---|---|---|---|",
    ]
    out.extend("| " + " | ".join(row) + " |" for row in tests)
    return "\n".join(out) + "\n", statuses


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--lifecycle-run")
    parser.add_argument("--history-run")
    parser.add_argument("--history-evidence", type=Path)
    args = parser.parse_args()
    if args.lifecycle_run and args.lifecycle_run != CANDIDATE["run_id"]:
        raise ValueError("Lifecycle run must match the candidate")
    if bool(args.history_run) != bool(args.history_evidence):
        raise ValueError("History run and downloaded evidence are required together")
    if args.history_evidence:
        gate = json.loads(args.history_evidence.read_text(encoding="utf-8-sig"))
        source = gate["candidateSource"]
        if (not args.history_run.isdecimal() or gate["overallStatus"] != "passed"
                or source["runId"] != CANDIDATE["run_id"] or source["artifactId"] != CANDIDATE["artifact_id"]
                or gate["candidateCommit"] != CANDIDATE["commit"]
                or gate["manifestSha256"] != CANDIDATE["manifest_sha256"]):
            raise ValueError("History evidence does not show a passing gate on the retained candidate")
    evidence = [json.loads(path.read_text(encoding="utf-8-sig")) for path in args.files]
    markdown, statuses = render(evidence, args.lifecycle_run, args.history_run)
    args.output.write_text(markdown, encoding="utf-8")
    return 1 if statuses["FAIL"] else 2 if statuses["OPEN"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
