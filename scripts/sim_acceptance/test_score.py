"""Regressions for empty attempts and proxy timing through the gate scorer."""

import unittest

from scripts.sim_acceptance.score import assess, score_text


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

    def test_missing_gpu_insertion_does_not_pass_and_replay_can_exceed_limit(self):
        evidence = {"trials": [{"id": "Q01", "mode": "quick", "stop_to_final_ms": 900}]}
        rows = assess("gpu-close-quiet", evidence, (None, None))
        status = {metric: value for _, metric, _, _, value in rows}
        self.assertEqual(status["Insertion / clipboard"], "OPEN")
        self.assertEqual(status["Quick stop → insert"], "FAIL")

    def test_gpu_proxy_below_limit_keeps_editor_evidence_open(self):
        evidence = {"trials": [
            {"id": f"Q{index:02}", "mode": "quick", "stop_to_final_ms": 500}
            for index in range(1, 21)
        ]}
        rows = assess("gpu-close-quiet", evidence, (100, None))
        quick = next(row for row in rows if row[1] == "Quick stop → insert")
        self.assertIn("p50 600.000", quick[3])
        self.assertIn("n=20", quick[3])
        self.assertEqual(quick[4], "OPEN")
