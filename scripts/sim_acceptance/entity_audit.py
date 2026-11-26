"""Audit the public entity fixture with Whisper English normalization.

Gate scoring retains its original normalization. This audit stores only the
short, public-corpus entity comparisons needed to explain differences.
"""

from __future__ import annotations

import re

from rapidfuzz.distance import Levenshtein
from whisper_normalization import EnglishTextNormalizer

from scripts.sim_acceptance.score import write_evidence
from scripts.validation_harness import PUNCT_REGEX

LEFT_GUARD = "eveentityleftguard"
RIGHT_GUARD = "eveentityrightguard"


class Alignment:
    def __init__(self, reference, hypothesis):
        self.hypothesis = hypothesis
        self.words = {}
        self.insertions = {}
        for op in Levenshtein.opcodes(reference, hypothesis):
            if op.tag in {"equal", "replace"}:
                for i, j in zip(range(op.src_start, op.src_end), range(op.dest_start, op.dest_end)):
                    self.words[i] = j
            elif op.tag == "insert":
                self.insertions[op.src_start] = range(op.dest_start, op.dest_end)

    def indices(self, start, end):
        indices = []
        for position in range(start, end):
            if position > start:
                indices.extend(self.insertions.get(position, ()))
            if position in self.words:
                indices.append(self.words[position])
        return indices

    def span(self, start, end):
        return [self.hypothesis[index] for index in self.indices(start, end)]


def reference_positions(reference, canonical, words, start, end, normalizer):
    left, right = words[start].start(), words[end - 1].end()
    marked = " ".join((reference[:left], LEFT_GUARD, reference[left:right], RIGHT_GUARD, reference[right:]))
    guarded = normalizer(marked).split()
    if LEFT_GUARD not in guarded or RIGHT_GUARD not in guarded:
        return []
    guarded_start = guarded.index(LEFT_GUARD)
    guarded.remove(LEFT_GUARD)
    guarded_end = guarded.index(RIGHT_GUARD)
    guarded.remove(RIGHT_GUARD)
    if guarded == canonical:
        return list(range(guarded_start, guarded_end))
    return Alignment(guarded, canonical).indices(guarded_start, guarded_end)


def analyze(clip, hypothesis, normalizer):
    reference = clip["reference"]
    raw_refs = list(re.finditer(r"\S+", PUNCT_REGEX.sub(" ", reference)))
    raw_hypothesis = PUNCT_REGEX.sub(" ", hypothesis.lower()).split()
    raw_words = [match.group().lower() for match in raw_refs]
    legacy = Alignment(raw_words, raw_hypothesis)
    expected = normalizer(reference).split()
    actual = normalizer(hypothesis).split()
    canonical = Alignment(expected, actual)
    exact = 0
    legacy_exact = 0
    unresolved = 0
    cases = []
    for index, (start, end, kind) in enumerate(clip["entities"]):
        raw_reference = raw_words[start:end]
        raw_output = legacy.span(start, end)
        legacy_hit = raw_output == raw_reference
        legacy_exact += legacy_hit
        positions = reference_positions(reference, expected, raw_refs, start, end, normalizer)
        if positions:
            canonical_reference = expected[positions[0]:positions[-1] + 1]
            canonical_output = canonical.span(positions[0], positions[-1] + 1)
            hit = canonical_output == canonical_reference
        else:
            canonical_reference, canonical_output = [], []
            unresolved += 1
            hit = False
        exact += hit
        if hit and legacy_hit:
            continue
        if not positions:
            classification = "mapping-unresolved"
        elif hit or legacy_hit:
            classification = "a"
        else:
            classification = "c"
        cases.append({
            "entity_index": index,
            "kind": kind,
            "reference": " ".join(raw_reference),
            "hypothesis_span": " ".join(raw_output),
            "normalized_reference": " ".join(canonical_reference),
            "normalized_hypothesis_span": " ".join(canonical_output),
            "legacy_exact": legacy_hit,
            "strict_exact": hit,
            "classification": classification,
        })
    return {
        "reference_words": len(expected),
        "word_errors": Levenshtein.distance(expected, actual),
        "entities_expected": len(clip["entities"]),
        "entities_exact": exact,
        "legacy_entities_exact": legacy_exact,
        "unresolved": unresolved,
        "cases": cases,
    }


class EntityAudit:
    def __init__(self, path, config, candidate):
        self.path = path
        self.normalizer = EnglishTextNormalizer()
        self.snapshot = {
            "candidate": candidate, "config": config, "normalizer": "whisper-normalization==1.0.0",
            "trials": [],
        }

    def observe(self, clip, hypothesis, scored):
        if hypothesis is None:
            return
        self.snapshot["trials"].append({
            "id": clip["id"], "mode": clip["mode"], "output_sha256": scored["output_sha256"],
            **analyze(clip, hypothesis, self.normalizer),
        })
        write_evidence(self.path, self.snapshot)
