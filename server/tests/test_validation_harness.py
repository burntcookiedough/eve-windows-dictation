"""Tests for Eve B4 validation harness, schema validation, pooling, and scoring."""
from __future__ import annotations

import copy, json, sys
from pathlib import Path
from typing import Any, Dict
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.validation_harness import (
    BASE_FIXTURE_RECORD,
    IncompatiblePoolingError,
    ValidationError,
    check_pooling_compatibility,
    compute_cer,
    compute_wer,
    ensure_safe_external_path,
    generate_fixture_demonstration_records,
    get_stratum_key,
    load_records_file,
    main,
    nearest_rank_percentile,
    normalize_text,
    stratify_and_summarize,
    summarize_stratum,
    validate_record_dict,
)

def _sample_valid_record(**kwargs: Any) -> Dict[str, Any]:
    rec = copy.deepcopy(BASE_FIXTURE_RECORD)
    for k, v in kwargs.items():
        if k in rec: rec[k] = v
        elif k in rec["environment"]: rec["environment"][k] = v
        elif k in rec["configuration"]: rec["configuration"][k] = v
        elif k in rec["trial_metadata"]: rec["trial_metadata"][k] = v
        elif k in rec["evaluation"]: rec["evaluation"][k] = v
    ev = rec["evaluation"]
    rw, we = ev.get("reference_word_count"), ev.get("word_errors")
    if rw and we is not None and "wer" not in kwargs:
        ev["wer"] = we / rw
        ev["wer_fraction"] = f"{we}/{rw} = {ev['wer']:.1%}"
    rc, ce = ev.get("reference_char_count"), ev.get("char_errors")
    if rc and ce is not None and "cer" not in kwargs:
        ev["cer"] = ce / rc
        ev["cer_fraction"] = f"{ce}/{rc} = {ev['cer']:.1%}"
    return rec

def test_schema_valid_and_bounds() -> None:
    rec = _sample_valid_record()
    assert validate_record_dict(rec) == []
    k = get_stratum_key(rec)
    assert k.commit == "0" * 40 and k.ram_gib == 16.0

    # Bad schema_version, bad commit, bad sha
    bad = _sample_valid_record(schema_version="0.9.0")
    assert any("schema_version" in e for e in validate_record_dict(bad))
    bad = _sample_valid_record()
    bad["build_info"]["commit"] = "not-a-hex"
    assert any("commit" in e for e in validate_record_dict(bad))

    # Negative number, bool as number, NaN
    bad = _sample_valid_record(ram_gib=-4.0)
    assert any("ram_gib" in e for e in validate_record_dict(bad))
    bad = _sample_valid_record(ram_gib=True)
    assert any("ram_gib" in e for e in validate_record_dict(bad))
    bad = _sample_valid_record(ram_gib=float("nan"))
    assert any("ram_gib" in e for e in validate_record_dict(bad))

    # Repetition index >= total repetitions
    bad = _sample_valid_record(repetition_index=5, total_repetitions=5)
    assert any("repetition_index" in e for e in validate_record_dict(bad))

    # Disallowed mic placeholder
    bad = _sample_valid_record(mic_model="generic")
    assert any("mic_model" in e for e in validate_record_dict(bad))

def test_unknown_keys_generic_and_unhashable_enum() -> None:
    rec = _sample_valid_record()
    rec["leaked_private_token_secret"] = "top_secret_data"
    errs = validate_record_dict(rec)
    assert any("unrecognized field detected" in e for e in errs)
    assert not any("leaked_private_token_secret" in e or "top_secret_data" in e for e in errs)

    rec2 = _sample_valid_record()
    rec2["build_info"]["leaked_path_key"] = "secret_value"
    errs2 = validate_record_dict(rec2)
    assert any("Field 'build_info': unrecognized field detected" in e for e in errs2)
    assert not any("leaked_path_key" in e for e in errs2)

    # Unhashable values in enum (dict, list) must not raise TypeError
    rec3 = _sample_valid_record(device_category={"unhashable": 1})
    errs3 = validate_record_dict(rec3)
    assert any("device_category" in e for e in errs3)

    rec4 = _sample_valid_record(device_category=["list", "category"])
    errs4 = validate_record_dict(rec4)
    assert any("device_category" in e for e in errs4)

def test_scoring_normalization_and_unscored_rates() -> None:
    errs, count, wer, frac = compute_wer("", "some hypothesis text")
    assert count == 0 and wer is None and frac is None

    # Normalization stripped vs raw exact
    ref, hyp = "Hello, world!", "hello world"
    _, _, wer_norm, _ = compute_wer(ref, hyp, normalize=True)
    _, _, wer_raw, _ = compute_wer(ref, hyp, normalize=False)
    assert wer_norm == 0.0 and wer_raw > 0.0

    # Unscored trial with non-null wer is rejected
    unscored = _sample_valid_record(reference_word_count=0, word_errors=None, wer=0.0)
    assert any("Field 'evaluation.wer'" in e for e in validate_record_dict(unscored))
    for fraction in ("1/100", "1/10 = 90.0%", "1/10 extra"):
        rec = _sample_valid_record()
        rec["evaluation"]["wer_fraction"] = fraction
        assert any("wer_fraction" in error for error in validate_record_dict(rec))

def test_pooling_dimensions_and_summarize_rejects_mismatched_records() -> None:
    rec1 = _sample_valid_record(run_id="r1", cpu="Intel i7-13700H")
    rec2 = _sample_valid_record(run_id="r2", cpu="Intel i7-13700H")
    check_pooling_compatibility([rec1, rec2])

    # Incompatible dimensions rejected
    for field, val in [("cpu", "AMD Ryzen 9"), ("corpus_id", "corpus_b"), ("warmup_policy", "policy_b"),
                       ("system_load", "heavy"), ("beam_size", 1), ("scoring_normalization", "raw"),
                       ("edge_case_type", "silence"), ("audio_duration_seconds", 35.0)]:
        diff = copy.deepcopy(rec1)
        diff["run_id"] = "r_diff"
        for section in ("environment", "configuration", "trial_metadata", "evaluation"):
            if field in diff[section]:
                diff[section][field] = val
        with pytest.raises(IncompatiblePoolingError):
            check_pooling_compatibility([rec1, diff])

    # Unresolved bug reproduction: summarize_stratum must reject pooling silence with speech
    speech_rec = _sample_valid_record(run_id="s1", edge_case_type=None)
    silence_rec = _sample_valid_record(run_id="silence1", edge_case_type="silence")
    speech_key = get_stratum_key(speech_rec)
    with pytest.raises(IncompatiblePoolingError):
        summarize_stratum(speech_key, [speech_rec, silence_rec])

def test_stratification_isolates_warmups_and_reports_word_and_char_counts() -> None:
    r_warm = _sample_valid_record(run_id="w1", is_warmup=True, word_errors=5, reference_word_count=10)
    r1 = _sample_valid_record(run_id="m1", is_warmup=False, word_errors=1, reference_word_count=10, char_errors=2, reference_char_count=50)
    r2 = _sample_valid_record(run_id="m2", is_warmup=False, word_errors=2, reference_word_count=10, char_errors=3, reference_char_count=50)
    r_silence = _sample_valid_record(
        run_id="e1", is_warmup=False, edge_case_type="silence", output_empty=True, expected_speech=False,
        reference_word_count=0, word_errors=None, wer=None, wer_fraction=None,
        reference_char_count=0, char_errors=None, cer=None, cer_fraction=None,
    )
    # Stratify isolates into separate strata (speech vs silence)
    strata = stratify_and_summarize([r_warm, r1, r2, r_silence])
    assert len(strata) == 2

    speech_sum = next(s for s in strata if s.key.edge_case_type is None)
    assert speech_sum.total_attempts == 3
    assert speech_sum.warmups_excluded == 1
    assert speech_sum.measured_trials == 2
    assert speech_sum.scored_word_trials_count == 2
    assert speech_sum.total_word_errors == 3 and speech_sum.total_ref_words == 20
    assert speech_sum.pooled_wer == 0.15
    assert speech_sum.scored_char_trials_count == 2
    assert speech_sum.total_char_errors == 5 and speech_sum.total_ref_chars == 100
    assert speech_sum.pooled_cer == 0.05
    silence_sum = next(s for s in strata if s.key.edge_case_type == "silence")
    assert silence_sum.pooled_wer is None and silence_sum.pooled_cer is None
    assert silence_sum.scored_word_trials_count == 0
    assert all(stage.observed_count == 0 and stage.p95_ms is None for stage in silence_sum.timings.values())

def test_nearest_rank_percentile() -> None:
    assert nearest_rank_percentile([], 50.0) is None
    assert nearest_rank_percentile([42.0], 0.0) == 42.0
    assert nearest_rank_percentile([42.0], 50.0) == 42.0
    assert nearest_rank_percentile([42.0], 100.0) == 42.0
    obs_20 = [float(i) for i in range(1, 21)]
    assert nearest_rank_percentile(obs_20, 95.0) == 19.0
    with pytest.raises(ValueError): nearest_rank_percentile([1.0], -5.0)
    with pytest.raises(ValueError): nearest_rank_percentile([True], 50.0)

def test_load_records_file_and_security_guards(tmp_path: Path) -> None:
    repo_file = REPO_ROOT / "docs" / "README.md"
    with pytest.raises(ValueError) as exc: ensure_safe_external_path(repo_file)
    assert "inside the repository" in str(exc.value)

    # External pretty JSON and NDJSON loading
    ext_dir = tmp_path.parent / "ext_data"
    ext_dir.mkdir(exist_ok=True)
    records = generate_fixture_demonstration_records()

    pretty_file = ext_dir / "pretty.json"
    pretty_file.write_text(json.dumps(records, indent=2), encoding="utf-8")
    loaded_pretty = load_records_file(pretty_file)
    assert len(loaded_pretty) == len(records)

    ndjson_file = ext_dir / "records.ndjson"
    ndjson_file.write_text("\n".join(json.dumps(r) for r in records), encoding="utf-8")
    loaded_ndjson = load_records_file(ndjson_file)
    assert len(loaded_ndjson) == len(records)

def test_cli_subcommands(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["demo"]) == 0
    assert "Eve B4 Validation Stratified Summary Report" in capsys.readouterr().out
    assert main(["baseline"]) == 0
    assert "n = 0 (PENDING)" in capsys.readouterr().out
    assert main(["template"]) == 0
    assert "FIXTURE_BUILD_NON_PRODUCT" in capsys.readouterr().out

    ext_dir = tmp_path.parent / "ext_cli_data"
    ext_dir.mkdir(exist_ok=True)
    fpath = ext_dir / "data.ndjson"
    fpath.write_text("\n".join(json.dumps(r) for r in generate_fixture_demonstration_records()), encoding="utf-8")
    assert main(["validate", str(fpath)]) == 0
    assert main(["aggregate", str(fpath)]) == 0
    assert main(["aggregate", str(fpath), "--format", "json"]) == 0

    ref_f, hyp_f = ext_dir / "ref.txt", ext_dir / "hyp.txt"
    ref_f.write_text("the quick brown fox", encoding="utf-8")
    hyp_f.write_text("the fast brown fox", encoding="utf-8")
    assert main(["score", "-rf", str(ref_f), "-hf", str(hyp_f)]) == 0
    assert "Word Error Rate" in capsys.readouterr().out


def test_invalid_score_counts_and_unreadable_inputs_do_not_leak(tmp_path, capsys):
    record = _sample_valid_record()
    record["evaluation"]["reference_word_count"] = "secret"
    record["evaluation"]["word_errors"] = {}
    # Avoid helper recalculation; malformed external JSON must be rejected without crashing.
    assert validate_record_dict(record)
    secret_path = tmp_path / "private-path-do-not-echo"
    secret_path.mkdir()
    assert main(["score", "-rf", str(secret_path), "-hf", str(secret_path)]) == 1
    output = capsys.readouterr()
    assert "private-path-do-not-echo" not in output.err
    assert "Traceback" not in output.err


def test_reparse_guard_rejects_parent_and_policy_changes_split_strata(tmp_path, monkeypatch):
    import scripts.validation_harness as harness
    from types import SimpleNamespace
    original = harness.os.lstat
    parent = tmp_path / "junction"
    parent.mkdir()
    child = parent / "records.json"
    child.write_text("[]", encoding="utf-8")
    def mocked_lstat(path, *args, **kwargs):
        if Path(path) == parent:
            return SimpleNamespace(st_file_attributes=0x400, st_mode=original(path).st_mode)
        return original(path, *args, **kwargs)
    monkeypatch.setattr(harness.os, "lstat", mocked_lstat)
    with pytest.raises(ValueError, match="Reparse"):
        ensure_safe_external_path(child)
    base = _sample_valid_record()
    for section, field in (("environment", "background_load_id"), ("configuration", "runtime_settings_id"), ("stage_timings", "measurement_policy_id")):
        changed = copy.deepcopy(base)
        changed[section][field] = "different-policy"
        with pytest.raises(IncompatiblePoolingError):
            summarize_stratum(get_stratum_key(base), [base, changed])
