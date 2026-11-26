"""Audit regressions for exact reference positions and English equivalences."""

import unittest

from whisper_normalization import EnglishTextNormalizer

from scripts.sim_acceptance.entity_audit import analyze


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
