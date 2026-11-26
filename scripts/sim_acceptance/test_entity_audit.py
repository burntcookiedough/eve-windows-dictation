"""Audit regressions for exact reference positions and English equivalences."""

import json
import tempfile
import unittest
from pathlib import Path

from whisper_normalization import EnglishTextNormalizer

from scripts.sim_acceptance.entity_audit import EntityAudit, analyze
from scripts.sim_acceptance.score import CANDIDATE, text_hash


class EntityAuditTests(unittest.TestCase):
    def test_number_title_and_spelling_normalize_on_both_sides(self):
        clip = {
            "reference": "Mr. Gray chose twenty one colours and Bob chose two.",
            "entities": [[0, 1, "name-or-term"], [3, 5, "number"],
                         [5, 6, "name-or-term"], [9, 10, "number"]],
        }
        result = analyze(clip, "Mister Gray chose 21 colors and Bob chose 2.", EnglishTextNormalizer())
        self.assertEqual(result["word_errors"], 0)
        self.assertEqual(result["entities_exact"], 4)
        self.assertEqual(result["legacy_entities_exact"], 0)
        self.assertEqual([case["classification"] for case in result["cases"]], ["a"] * 4)

    def test_word_at_another_position_does_not_get_entity_credit(self):
        clip = {"reference": "Mary saw Alice there yesterday", "entities": [[2, 3, "name-or-term"]]}
        result = analyze(clip, "Alice saw Mary there yesterday", EnglishTextNormalizer())
        self.assertEqual(result["entities_exact"], 0)
        self.assertEqual(result["cases"][0]["hypothesis_span"], "mary")
        self.assertEqual(result["cases"][0]["classification"], "c")

    def test_uploaded_sidecar_uses_reference_ids_and_scores_without_hypothesis_text(self):
        clip = {"id": "Q01", "mode": "quick", "reference": "Alice Jones arrived",
                "entities": [[0, 2, "name-or-term"]]}
        hypothesis = "Alice " + "uniquehypothesisspan " * 500 + "Jones arrived"
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "audit.json"
            EntityAudit(path, "close-quiet", CANDIDATE).observe(
                clip, hypothesis, {"output_sha256": text_hash(hypothesis)}
            )
            raw = path.read_text(encoding="utf-8")
        self.assertNotIn("uniquehypothesisspan", raw)
        trial, = json.loads(raw)["trials"]
        self.assertEqual(trial["id"], "Q01")
        self.assertEqual(trial["cases"][0]["entity_index"], 0)
        self.assertEqual(trial["output_sha256"], text_hash(hypothesis))
