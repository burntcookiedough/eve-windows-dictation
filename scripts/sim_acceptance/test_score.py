"""Regressions for empty attempts and proxy timing through the gate scorer."""

import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.sim_acceptance import score
from scripts.sim_acceptance.score import CANDIDATE, assess, render, score_text


class AcceptanceScoreTests(unittest.TestCase):
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
        }}
        report, _ = render([evidence], None, None)
        for metric, status in (("Canary omitted from logs with tracing off", "FAIL"),
                               ("Cancel during capture and next Quick", "FAIL"),
                               ("Cancel during finalization and next Quick", "OPEN")):
            row = next(line for line in report.splitlines() if metric in line)
            self.assertTrue(row.endswith(f"| {status} |"), row)

    def test_history_report_binds_verified_zip_to_its_workflow_run(self):
        with tempfile.TemporaryDirectory() as temp:
            artifact = Path(temp) / "history.zip"
            with zipfile.ZipFile(artifact, "w") as archive:
                archive.writestr("functional-history-evidence.json", json.dumps({
                    "overallStatus": "passed",
                    "candidateSource": {"runId": CANDIDATE["run_id"],
                                        "artifactId": CANDIDATE["artifact_id"]},
                    "candidateCommit": CANDIDATE["commit"],
                    "manifestSha256": CANDIDATE["manifest_sha256"],
                }))
            metadata = Path(temp) / "metadata.json"
            metadata.write_text(json.dumps({
                "id": 456, "name": "eve-retained-history-evidence-123",
                "workflow_run": {"id": 123},
                "digest": "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest(),
                "size_in_bytes": artifact.stat().st_size,
            }), encoding="utf-8")
            self.assertEqual(score.verify_history("123", artifact, metadata), "123")
            with self.assertRaisesRegex(ValueError, "History artifact"):
                score.verify_history("124", artifact, metadata)
            artifact.write_bytes(artifact.read_bytes() + b"corrupt")
            with self.assertRaisesRegex(ValueError, "History artifact"):
                score.verify_history("123", artifact, metadata)

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
