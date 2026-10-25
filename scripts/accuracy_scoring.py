"""Deterministic edit-decomposition and safe aggregate accuracy report accumulator.

Exposes substitutions, deletions, and insertions (S/D/I) consistent with
Levenshtein distance while scoring both raw and standard normalization modes on
identical reference/hypothesis observation pairs in memory.

Privacy guarantee: NEVER persists speech text, hypotheses, or transcripts.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from scripts.validation_harness import (
    compute_cer,
    compute_wer,
    get_stratum_key,
    normalize_text,
)


def decompose_levenshtein(seq1: Sequence[Any], seq2: Sequence[Any]) -> Tuple[int, int, int, int]:
    """Count insertions, deletions, and substitutions with one rolling row.

    seq1 is the reference sequence; seq2 is the hypothesis sequence.
    Returns: (distance, substitutions, deletions, insertions)

    Invariant: distance == substitutions + deletions + insertions.
    Deterministic tie-break order when multiple paths have equal minimal distance:
        1. Match / Substitution (diagonal transition)
        2. Deletion (from reference, vertical transition)
        3. Insertion (into hypothesis, horizontal transition)

    Memory complexity: O(len(seq2)) using a single rolling DP row,
    preventing quadratic memory regression on long speech sequences.
    """
    if not seq1 and not seq2:
        return 0, 0, 0, 0
    if not seq1:
        return len(seq2), 0, 0, len(seq2)
    if not seq2:
        return len(seq1), 0, len(seq1), 0

    # dp[j] stores (cost, S, D, I) to reach (i, j)
    dp: List[Tuple[int, int, int, int]] = [(j, 0, 0, j) for j in range(len(seq2) + 1)]
    for i, item1 in enumerate(seq1, 1):
        prev = dp[0]
        dp[0] = (i, 0, i, 0)
        for j, item2 in enumerate(seq2, 1):
            if item1 == item2:
                cand_diag = (prev[0], prev[1], prev[2], prev[3])
            else:
                cand_diag = (prev[0] + 1, prev[1] + 1, prev[2], prev[3])
            cand_del = (dp[j][0] + 1, dp[j][1], dp[j][2] + 1, dp[j][3])
            cand_ins = (dp[j - 1][0] + 1, dp[j - 1][1], dp[j - 1][2], dp[j - 1][3] + 1)

            min_dist = min(cand_diag[0], cand_del[0], cand_ins[0])
            # Deterministic tie-break order: Substitution > Deletion > Insertion
            if cand_diag[0] == min_dist:
                best = cand_diag
            elif cand_del[0] == min_dist:
                best = cand_del
            else:
                best = cand_ins
            prev = dp[j]
            dp[j] = best
    return dp[-1]


def decompose_words(ref_text: str, hyp_text: str, *, normalize: bool = True) -> Tuple[int, int, int, int, int, Optional[float], Optional[str]]:
    """Score whitespace-delimited words and decompose errors into (dist, S, D, I, ref_count, rate, fraction).

    Reuses compute_wer as the metric truth for (dist, ref_count, rate, fraction).
    """
    errs, count, wer, fraction = compute_wer(ref_text, hyp_text, normalize=normalize)
    if count == 0:
        return 0, 0, 0, 0, 0, None, None
    r_words = (normalize_text(ref_text) if normalize else ref_text.strip()).split()
    h_words = (normalize_text(hyp_text) if normalize else hyp_text.strip()).split()
    dist, s, d, i = decompose_levenshtein(r_words, h_words)
    if dist != errs:
        raise ValueError(f"Word decomposition distance {dist} does not match compute_wer errors {errs}")
    return dist, s, d, i, count, wer, fraction


def decompose_chars(ref_text: str, hyp_text: str, *, normalize: bool = True) -> Tuple[int, int, int, int, int, Optional[float], Optional[str]]:
    """Score non-whitespace characters and decompose errors into (dist, S, D, I, ref_count, rate, fraction).

    Reuses compute_cer as the metric truth for (dist, ref_count, rate, fraction).
    """
    errs, count, cer, fraction = compute_cer(ref_text, hyp_text, normalize=normalize)
    if count == 0:
        return 0, 0, 0, 0, 0, None, None
    r_chars = [c for c in (normalize_text(ref_text) if normalize else ref_text.strip()) if not c.isspace()]
    h_chars = [c for c in (normalize_text(hyp_text) if normalize else hyp_text.strip()) if not c.isspace()]
    dist, s, d, i = decompose_levenshtein(r_chars, h_chars)
    if dist != errs:
        raise ValueError(f"Char decomposition distance {dist} does not match compute_cer errors {errs}")
    return dist, s, d, i, count, cer, fraction


@dataclass
class EditCounts:
    """Aggregate edit counters for words or characters."""
    scored_trials: int = 0
    total_ref_units: int = 0
    substitutions: int = 0
    deletions: int = 0
    insertions: int = 0
    total_errors: int = 0

    @property
    def error_rate(self) -> Optional[float]:
        return (self.total_errors / self.total_ref_units) if self.total_ref_units > 0 else None

    @property
    def fraction(self) -> str:
        rate = self.error_rate
        return f"{self.total_errors}/{self.total_ref_units} = {rate:.1%}" if rate is not None else "unavailable"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "scored_trials": self.scored_trials,
            "total_ref_units": self.total_ref_units,
            "substitutions": self.substitutions,
            "deletions": self.deletions,
            "insertions": self.insertions,
            "total_errors": self.total_errors,
            "rate": self.error_rate,
            "fraction": self.fraction,
        }


@dataclass
class ModeAccumulator:
    """Accumulates word and character error decompositions for one normalization mode."""
    words: EditCounts = field(default_factory=EditCounts)
    chars: EditCounts = field(default_factory=EditCounts)

    def record(self, ref_text: str, hyp_text: str, *, normalize: bool) -> None:
        w_dist, w_s, w_d, w_i, w_ref, _, _ = decompose_words(ref_text, hyp_text, normalize=normalize)
        if w_ref > 0:
            self.words.scored_trials += 1
            self.words.total_ref_units += w_ref
            self.words.substitutions += w_s
            self.words.deletions += w_d
            self.words.insertions += w_i
            self.words.total_errors += w_dist

        c_dist, c_s, c_d, c_i, c_ref, _, _ = decompose_chars(ref_text, hyp_text, normalize=normalize)
        if c_ref > 0:
            self.chars.scored_trials += 1
            self.chars.total_ref_units += c_ref
            self.chars.substitutions += c_s
            self.chars.deletions += c_d
            self.chars.insertions += c_i
            self.chars.total_errors += c_dist

    def to_dict(self) -> Dict[str, Any]:
        return {
            "word_scoring": {
                "scored_trials": self.words.scored_trials,
                "total_ref_words": self.words.total_ref_units,
                "substitutions": self.words.substitutions,
                "deletions": self.words.deletions,
                "insertions": self.words.insertions,
                "total_word_errors": self.words.total_errors,
                "wer": self.words.error_rate,
                "wer_fraction": self.words.fraction,
            },
            "char_scoring": {
                "scored_trials": self.chars.scored_trials,
                "total_ref_chars": self.chars.total_ref_units,
                "substitutions": self.chars.substitutions,
                "deletions": self.chars.deletions,
                "insertions": self.chars.insertions,
                "total_char_errors": self.chars.total_errors,
                "cer": self.chars.error_rate,
                "cer_fraction": self.chars.fraction,
            },
        }


@dataclass
class StratumAccuracyAccumulator:
    """Accumulates accuracy metrics for one stratum, pairing raw and standard modes."""
    stratum_key: Dict[str, Any]
    total_attempts: int = 0
    warmups_excluded: int = 0
    measured_trials: int = 0
    unexpected_failures: int = 0
    observed_empty_count: int = 0
    expected_speech_trials: int = 0
    raw: ModeAccumulator = field(default_factory=ModeAccumulator)
    standard: ModeAccumulator = field(default_factory=ModeAccumulator)

    def record(self, clip: Dict[str, Any], observation: Dict[str, Any], *, is_warmup: bool) -> None:
        self.total_attempts += 1
        if is_warmup:
            self.warmups_excluded += 1
            return

        self.measured_trials += 1
        self.expected_speech_trials += 1

        hyp_text = observation.get("text")
        outcome = observation.get("outcome", "unexpected_failure")

        # Failure counter: independent of empty, counted if outcome != success or hyp_text is None
        is_failure = (outcome != "success") or (hyp_text is None)
        if is_failure:
            self.unexpected_failures += 1

        # Observed empty: only when text is delivered (not None) and empty/whitespace
        is_empty = (hyp_text is not None) and (not hyp_text.strip())
        if is_empty:
            self.observed_empty_count += 1

        # Available text can still score as current make_record does
        if hyp_text is not None:
            ref_path = clip["reference"]
            ref_text = ref_path.read_text(encoding="utf-8-sig") if isinstance(ref_path, Path) else Path(ref_path).read_text(encoding="utf-8-sig")
            self.raw.record(ref_text, hyp_text, normalize=False)
            self.standard.record(ref_text, hyp_text, normalize=True)

    def to_dict(self) -> Dict[str, Any]:
        meas = self.measured_trials
        exp_n = self.expected_speech_trials
        unexp_rate = (self.unexpected_failures / meas) if meas > 0 else None
        empty_rate = (self.observed_empty_count / exp_n) if exp_n > 0 else None

        return {
            "stratum_key": self.stratum_key,
            "trial_counts": {
                "total_attempts": self.total_attempts,
                "warmups_excluded": self.warmups_excluded,
                "measured_trials": meas,
                "unexpected_failures": self.unexpected_failures,
                "unexpected_failure_rate": unexp_rate,
                "unexpected_failure_fraction": f"{self.unexpected_failures}/{meas} = {unexp_rate:.1%}" if unexp_rate is not None else "unavailable",
                "observed_empty_count": self.observed_empty_count,
                "observed_empty_rate": empty_rate,
                "observed_empty_fraction": f"{self.observed_empty_count}/{exp_n} = {empty_rate:.1%}" if empty_rate is not None else "unavailable",
                "expected_speech_trials": exp_n,
            },
            "modes": {
                "raw": self.raw.to_dict(),
                "standard": self.standard.to_dict(),
            },
            "critical_entity_review": {
                "status": "unavailable",
                "review_availability": False,
                "critical_entity_errors": None,
                "notes": "Human review required; automated metric unavailable",
            },
        }


class AccuracyAccumulator:
    """Accumulates accuracy across multiple clips and repetitions by stratum.

    Keeps ZERO transcript or speech text in memory across trials.
    """

    def __init__(self, template_record: Dict[str, Any]) -> None:
        self.template = copy.deepcopy(template_record)
        self.strata: Dict[Tuple[Any, ...], StratumAccuracyAccumulator] = {}

    def _get_stratum_info(self, record: Dict[str, Any]) -> Tuple[Tuple[Any, ...], Dict[str, Any]]:
        full_key = get_stratum_key(record)
        full_dict = full_key.to_display_dict()
        stratum_dict = {k: v for k, v in full_dict.items() if k != "scoring_normalization"}
        key_id = tuple(sorted(stratum_dict.items()))
        return key_id, stratum_dict

    def record_trial(
        self,
        record: Dict[str, Any],
        *,
        clip: Dict[str, Any],
        observation: Optional[Dict[str, Any]] = None,
    ) -> None:
        is_warmup = bool(record["trial_metadata"]["is_warmup"])
        key_id, stratum_dict = self._get_stratum_info(record)
        if key_id not in self.strata:
            self.strata[key_id] = StratumAccuracyAccumulator(stratum_key=stratum_dict)
        self.strata[key_id].record(clip, observation or {}, is_warmup=is_warmup)

    def record_observation(
        self,
        clip: Dict[str, Any],
        observation: Dict[str, Any],
        *,
        is_warmup: bool = False,
        record: Optional[Dict[str, Any]] = None,
    ) -> None:
        if record is None:
            from scripts.perf_regression_benchmark import make_record
            complete_observation = {
                "first_partial_ms": None, "last_audio_ms": None,
                "stop_to_final_text_ms": None, "server_perf": None,
                "text": None, "outcome": "unexpected_failure", **observation,
            }
            record = make_record(
                self.template,
                clip,
                complete_observation,
                run_id="in-memory-run",
                trial_id="in-memory-trial",
                repetition=0,
                repetitions=1,
                warmup=is_warmup,
                raw=False,
            )
        self.record_trial(record, clip=clip, observation=observation)

    def to_dict(self, *, run_id: str) -> Dict[str, Any]:
        return {
            "report_type": "b4_accuracy_aggregate_report_v1",
            "run_id": run_id,
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "build_info": {
                "commit": self.template["build_info"]["commit"],
                "artifact_name": self.template["build_info"]["artifact_name"],
                "artifact_sha256": self.template["build_info"]["artifact_sha256"],
                "clean_tree": self.template["build_info"]["clean_tree"],
            },
            "environment": {
                "os_build": self.template["environment"]["os_build"],
                "cpu": self.template["environment"]["cpu"],
                "ram_gib": self.template["environment"]["ram_gib"],
                "gpu": self.template["environment"]["gpu"],
                "gpu_driver": self.template["environment"]["gpu_driver"],
                "device_category": self.template["environment"]["device_category"],
                "mic_model": self.template["environment"]["mic_model"],
                "acoustic_environment": self.template["environment"]["acoustic_environment"],
                "background_noise_level": self.template["environment"]["background_noise_level"],
                "system_load": self.template["environment"]["system_load"],
                "background_load_id": self.template["environment"]["background_load_id"],
            },
            "configuration": {
                "requested_model": self.template["configuration"]["requested_model"],
                "effective_model": self.template["configuration"]["effective_model"],
                "requested_device": self.template["configuration"]["requested_device"],
                "effective_device": self.template["configuration"]["effective_device"],
                "requested_compute_type": self.template["configuration"]["requested_compute_type"],
                "effective_compute_type": self.template["configuration"]["effective_compute_type"],
                "partials_enabled": self.template["configuration"]["partials_enabled"],
                "dictation_mode": self.template["configuration"]["dictation_mode"],
                "beam_size": self.template["configuration"]["beam_size"],
                "language": self.template["configuration"]["language"],
                "runtime_settings_id": self.template["configuration"]["runtime_settings_id"],
            },
            "policy_metadata": {
                "normalization_policy": "existing_validation_harness_v1",
                "edit_decomposition_tie_break": "substitutions_over_deletions_over_insertions",
                "empty_reference_policy": "unavailable",
                "failed_trial_policy": "preserved_in_denominator_available_text_scored",
                "observed_empty_policy": "scored_as_full_deletions",
                "critical_entity_review_policy": "human_review_required_unavailable",
                "privacy_guarantee": "no_speech_or_transcript_text_persisted",
            },
            "report_status": "complete",
            "critical_entity_review_availability": False,
            "strata": [s.to_dict() for s in self.strata.values()],
        }
