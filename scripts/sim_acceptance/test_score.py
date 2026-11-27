"""Regressions for empty attempts and proxy timing through the gate scorer."""

import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from scripts.sim_acceptance import score
from scripts.sim_acceptance.score import CANDIDATE, assess, render, score_text

NEW_CANDIDATE = {
    "run_id": "45880000001",
    "artifact_id": "15110000002",
    "commit": "ab" * 20,
    "manifest_sha256": "cd" * 32,
}


class AcceptanceScoreTests(unittest.TestCase):
    def test_cli_scores_the_new_candidate_across_the_full_hosted_matrix(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            evidence_files = []
            for config in score.CONFIGS[:4]:
                path = root / f"{config}.json"
                path.write_text(json.dumps({"candidate": NEW_CANDIDATE, "config": config}), encoding="utf-8")
                evidence_files.append(str(path))
            report = root / "report.md"
            pins = [NEW_CANDIDATE["run_id"], NEW_CANDIDATE["artifact_id"],
                    NEW_CANDIDATE["commit"].upper(), NEW_CANDIDATE["manifest_sha256"].upper()]
            args = ["score.py", "--output", str(report), "--candidate", *pins, *evidence_files]
            with patch("sys.argv", [*args, "--lifecycle-run", NEW_CANDIDATE["run_id"]]):
                self.assertEqual(score.main(), 2)  # Fixtures leave the measurement gates open.
            markdown = report.read_text(encoding="utf-8")
            for pin in NEW_CANDIDATE.values():
                self.assertIn(pin, markdown)
            with patch("sys.argv", [*args, "--lifecycle-run", CANDIDATE["run_id"]]):
                with self.assertRaisesRegex(ValueError, "Lifecycle run must match"):
                    score.main()

    def test_rejects_evidence_that_does_not_match_the_exact_expected_tuple(self):
        evidence = {"candidate": NEW_CANDIDATE, "config": "close-quiet"}
        with self.assertRaisesRegex(ValueError, "Every evidence file"):
            render([evidence], None, None)  # Default remains the legacy candidate.
        mismatches = [{**NEW_CANDIDATE, key: CANDIDATE[key]} for key in NEW_CANDIDATE]
        mismatches.extend((None, {"commit": NEW_CANDIDATE["commit"]}, {**NEW_CANDIDATE, "extra": True}))
        for candidate in mismatches:
            with self.subTest(candidate=candidate):
                with self.assertRaisesRegex(ValueError, "Every evidence file"):
                    render([evidence, {"candidate": candidate, "config": "far-quiet"}], None, None,
                           expected_candidate=NEW_CANDIDATE)

    def test_cli_rejects_malformed_candidate_override(self):
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / "report.md"
            for field, malformed in (("run_id", "0"), ("artifact_id", "12.3"), ("commit", "g" * 40),
                                     ("manifest_sha256", "a" * 63)):
                with self.subTest(field=field):
                    pins = {**NEW_CANDIDATE, field: malformed}
                    with patch("sys.argv", ["score.py", "--output", str(report), "--candidate", *pins.values()]):
                        with self.assertRaises(SystemExit) as caught:
                            score.main()
                        self.assertEqual(caught.exception.code, 2)
                    self.assertFalse(report.exists())

    def test_observed_empty_and_unobservable_are_distinct(self):
        clip = {"reference": "Ship thirty cases", "entities": [[1, 2, "number"]]}
        self.assertEqual(score_text(clip, "")["word_errors"], 3)
        self.assertEqual(score_text(clip, "")["entities_exact"], 0)
        self.assertNotIn("word_errors", score_text(clip, None))

    def test_vocab_requires_exact_reference_position(self):
        clip = {"reference": "At nine Lucy named twenty one", "entities": [[4, 6, "number"]]}
        self.assertEqual(score_text(clip, "At 9 Lucy named twenty one")["entities_exact"], 1)
        self.assertEqual(score_text(clip, "At nine Lucy named 21")["entities_exact"], 0)

    def test_missing_gpu_insertion_stays_open_when_replay_exceeds_limit(self):
        evidence = {"trials": [{"id": "Q01", "mode": "quick", "stop_to_final_ms": 900}]}
        rows = assess("gpu-close-quiet", evidence)
        status = {metric: value for _, metric, _, _, value in rows}
        self.assertEqual(status["Insertion / clipboard"], "OPEN")
        self.assertEqual(status["Quick stop → insert"], "OPEN")

    def test_partial_bad_trial_does_not_decide_rates_or_percentiles(self):
        trials = [
            {"id": "Q01", "mode": "quick", "reference_words": 10, "word_errors": 10,
             "entities_expected": 1, "entities_exact": 0, "stop_to_insert_ms": 4000},
            {"id": "Q02", "mode": "quick", "reference_words": 10, "entities_expected": 1},
        ]
        gates = {row[1]: row for row in assess("close-quiet", {"trials": trials})}
        for metric in ("Quick WER", "Names / numbers / terms", "Quick stop → insert"):
            self.assertEqual(gates[metric][4], "OPEN", metric)
        self.assertIn("2 attempted", gates["Quick WER"][3])
        self.assertIn("20 attempted reference words", gates["Quick WER"][3])
        self.assertIn("2 attempted entities", gates["Names / numbers / terms"][3])

    def test_confirmed_empty_trials_are_deletions_even_without_legacy_error_counts(self):
        trials = [
            {"id": f"Q{index:02}", "mode": "quick", "reference_words": 10,
             "entities_expected": 1, "empty": True, "output_observed": True}
            for index in range(1, 21)
        ]
        gates = {row[1]: row for row in assess("close-quiet", {"trials": trials})}
        self.assertEqual(gates["Quick WER"][4], "FAIL")
        self.assertIn("200/200", gates["Quick WER"][3])

    def test_long_heuristic_flags_short_repeat_and_single_word_survivor(self):
        clip = {"reference": "hello world a difficult passage ends here today", "entities": [],
                "chunks": [[0, 2], [2, 7], [7, 8]]}
        scored = score_text(clip, "hello world hello world passage today")
        self.assertEqual(scored["chunk_heuristic_repeated"], 1)
        self.assertEqual(scored["chunk_heuristic_missing"], 1)

    def test_legacy_long_clean_heuristic_leaves_strict_chunk_gate_open(self):
        long = {"id": "L01", "mode": "long", "duration_s": 1800, "chunks_expected": 2,
                "chunks_missing": 0, "chunks_repeated": 0}
        gates = {row[1]: row for row in assess("close-quiet", {"trials": [long]})}
        self.assertEqual(gates["Long chunks"][4], "OPEN")
        report, _ = render([{"candidate": CANDIDATE, "config": "close-quiet", "trials": [long]}], None, None)
        self.assertIn("| close-quiet | Legacy transcript alignment | 2 | 0 | 0 |", report)

    def test_long_rss_requires_coverage(self):
        evidence = {"resources": {"long_sample_count": 1, "long_peak_rss_gib": 1.0}}
        gates = {row[1]: row for row in assess("close-quiet", evidence)}
        self.assertEqual(gates["Long peak RSS"][4], "OPEN")

    def test_robustness_preserves_positive_leak_and_forced_exit(self):
        evidence = {"candidate": CANDIDATE, "robustness": {
            "canary-off": {"status": "OPEN", "matches": 1, "canary_inserted": False},
            "cancel-capture": {"status": "PASS", "cancellation_phase_reached": True,
                               "close_request_sent": True, "exit_path": "forced-after-timeout"},
            "cancel-final": {"status": "PASS"},
            "immediate-stop": {"status": "PASS", "stop_in_window": False},
        }}
        report, _ = render([evidence], None, None)
        for metric, status in (("Canary omitted from logs with tracing off", "FAIL"),
                               ("Cancel during capture and next Quick", "FAIL"),
                               ("Cancel during finalization and next Quick", "OPEN"),
                               ("Immediate stop and next Quick", "OPEN")):
            row = next(line for line in report.splitlines() if metric in line)
            self.assertTrue(row.endswith(f"| {status} |"), row)

    def test_history_report_binds_verified_zip_to_its_workflow_run(self):
        for expected in (CANDIDATE, NEW_CANDIDATE):
            with self.subTest(commit=expected["commit"]):
                self.check_history_candidate(expected)

    def check_history_candidate(self, expected):
        with tempfile.TemporaryDirectory() as temp:
            artifact = Path(temp) / "history.zip"
            with zipfile.ZipFile(artifact, "w") as archive:
                archive.writestr("functional-history-evidence.json", json.dumps({
                    "overallStatus": "passed",
                    "candidateSource": {"runId": expected["run_id"], "artifactId": expected["artifact_id"]},
                    "candidateCommit": expected["commit"],
                    "manifestSha256": expected["manifest_sha256"],
                }))
            metadata = Path(temp) / "metadata.json"
            metadata.write_text(json.dumps({
                "id": 456, "name": "eve-retained-history-evidence-123",
                "workflow_run": {"id": 123},
                "digest": "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest(),
                "size_in_bytes": artifact.stat().st_size,
            }), encoding="utf-8")
            self.assertEqual(score.verify_history("123", artifact, metadata, expected_candidate=expected), "123")
            other = NEW_CANDIDATE if expected == CANDIDATE else CANDIDATE
            with self.assertRaisesRegex(ValueError, "passing gate on the retained candidate"):
                score.verify_history("123", artifact, metadata, expected_candidate=other)
            with self.assertRaisesRegex(ValueError, "History artifact"):
                score.verify_history("124", artifact, metadata, expected_candidate=expected)
            artifact.write_bytes(artifact.read_bytes() + b"corrupt")
            with self.assertRaisesRegex(ValueError, "History artifact"):
                score.verify_history("123", artifact, metadata, expected_candidate=expected)

    def test_gpu_proxy_below_limit_keeps_editor_evidence_open(self):
        evidence = {"trials": [
            {"id": f"Q{index:02}", "mode": "quick", "stop_to_final_ms": 500}
            for index in range(1, 21)
        ]}
        rows = assess("gpu-close-quiet", evidence)
        quick = next(row for row in rows if row[1] == "Quick stop → insert")
        self.assertEqual(quick[4], "OPEN")
        gpu = {**evidence, "candidate": CANDIDATE, "config": "gpu-close-quiet"}
        cpu = {"candidate": CANDIDATE, "config": "close-quiet", "trials": [
            {"id": "Q01", "mode": "quick", "observed_insert_overhead_ms": 100}
        ]}
        report, _ = render([cpu, gpu], None, None)
        self.assertIn("| gpu-close-quiet | Quick | 20 | 500.000 / 500.000 | 600.000 / 600.000 |", report)
