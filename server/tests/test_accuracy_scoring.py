"""Unit and integration tests for comparable accuracy scoring and safe sidecar reporting.

Verifies:
1. Same utterance case/punctuation raw different, standard zero.
2. S + D + I matches existing WER/CER counts with substitutions, deletions, insertions, repetition, Unicode, empty reference.
3. Failures (None, nonempty, whitespace) and delivered empty are tracked independently:
   - failed/nonempty counts failure, scores available text, empty == 0.
   - failed/whitespace counts failure, scores deletions, empty == 1.
   - failure None counts failure, empty == 0, unscored.
   - ordinary success nonempty and empty.
   - no failure becomes ordinary success.
4. Complete get_stratum_key reused, excluding only scoring_normalization. No incompatible pooling. Full safe run/build provenance.
5. Reuses compute_wer and compute_cer as metric truth; decomposition matches them.
6. Warmup trials are excluded from measured denominators and scoring pools.
7. Exactly the same observation text is scored once for both raw and standard modes.
8. Output aggregate contains NO input speech text and preserves schema/privacy.
9. Integration tests at mock replay_trial seam:
   - Existing accuracy_output fails before network/output mutation; bytes unchanged; replay not called.
   - Path collision with output (including case alias), manifest, reference, audio rejected.
   - Partial execution preserves an explicitly incomplete sidecar.
   - Atomic publication preserves that placeholder on report I/O failure.
   - Primary trial records survive sidecar error.
   - Default record write unchanged.
"""
import asyncio
import copy
from contextlib import ExitStack
import io
import json
import os
from pathlib import Path
import wave
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.accuracy_scoring import (
    AccuracyAccumulator,
    decompose_chars,
    decompose_levenshtein,
    decompose_words,
)
from scripts.perf_regression_benchmark import (
    make_record as build_trial_record,
    run_replay,
)
from scripts.validation_harness import (
    BASE_FIXTURE_RECORD,
    compute_cer,
    compute_wer,
    get_stratum_key,
    validate_record_dict,
)


def make_record(template, clip, observation, **kwargs):
    complete = {"first_partial_ms": None, "last_audio_ms": None,
                "stop_to_final_text_ms": None, "server_perf": None,
                "text": None, "outcome": "unexpected_failure", **observation}
    return build_trial_record(template, clip, complete, **kwargs)


def test_same_utterance_case_and_punctuation_raw_different_standard_zero():
    """Punctuation and case differ under raw scoring, but yield zero errors under standard normalization."""
    ref = "The quick, brown fox jumps over the lazy dog."
    hyp = "the quick brown fox jumps over the lazy dog"

    # Word scoring
    raw_w_dist, raw_s, raw_d, raw_i, raw_w_ref, raw_wer, _ = decompose_words(ref, hyp, normalize=False)
    std_w_dist, std_s, std_d, std_i, std_w_ref, std_wer, _ = decompose_words(ref, hyp, normalize=True)

    assert raw_w_dist > 0, "Raw word distance should reflect case/punctuation differences"
    assert raw_wer > 0.0
    assert std_w_dist == 0, "Standard word distance must normalize case/punctuation to zero"
    assert std_wer == 0.0
    assert (std_s, std_d, std_i) == (0, 0, 0)

    # Char scoring
    raw_c_dist, raw_cs, raw_cd, raw_ci, raw_c_ref, raw_cer, _ = decompose_chars(ref, hyp, normalize=False)
    std_c_dist, std_cs, std_cd, std_ci, std_c_ref, std_cer, _ = decompose_chars(ref, hyp, normalize=True)

    assert raw_c_dist > 0, "Raw character distance should reflect case/punctuation differences"
    assert raw_cer > 0.0
    assert std_c_dist == 0, "Standard character distance must normalize case/punctuation to zero"
    assert std_cer == 0.0
    assert (std_cs, std_cd, std_ci) == (0, 0, 0)


def test_s_d_i_matches_existing_wer_cer_counts_across_variations():
    """S + D + I must equal the Levenshtein distance and match compute_wer / compute_cer as metric truth."""
    test_cases = [
        ("one two three", "one four three"),
        ("one two three", "one three"),
        ("one three", "one two three"),
        ("test phrase", "test phrase test phrase"),
        ("the brown fox jumps quickly", "a brown dog jumps slowly indeed"),
        ("café naïve résumé", "cafe naive resume"),
        ("こんにちは世界", "こんばんは世界"),
        ("empty hyp", ""),
        ("", "empty ref"),
        ("", ""),
    ]

    for ref, hyp in test_cases:
        for norm in (True, False):
            # Words
            dist, s, d, i, ref_count, wer, frac = decompose_words(ref, hyp, normalize=norm)
            exp_errs, exp_count, exp_wer, exp_frac = compute_wer(ref, hyp, normalize=norm)
            assert dist == s + d + i, f"S+D+I must equal total distance: {s}+{d}+{i}!={dist}"
            assert dist == exp_errs
            assert ref_count == exp_count
            assert wer == exp_wer
            assert frac == exp_frac

            # Chars
            c_dist, cs, cd, ci, c_ref_count, cer, c_frac = decompose_chars(ref, hyp, normalize=norm)
            exp_c_errs, exp_c_count, exp_cer, exp_c_frac = compute_cer(ref, hyp, normalize=norm)
            assert c_dist == cs + cd + ci, f"Char S+D+I must equal total distance: {cs}+{cd}+{ci}!={c_dist}"
            assert c_dist == exp_c_errs
            assert c_ref_count == exp_c_count
            assert cer == exp_cer
            assert c_frac == exp_c_frac


def test_failure_counter_independent_of_observed_empty(tmp_path):
    """Failure counter is evaluated independently of observed empty.

    Verifies:
    - failed/nonempty counts failure, empty == 0, available text is scored.
    - failed/whitespace counts failure, empty == 1, scored as deletions.
    - failure None counts failure, empty == 0, unscored.
    - ordinary success nonempty: failures == 0, empty == 0.
    - ordinary success empty: failures == 0, empty == 1.
    - No failure becomes ordinary success.
    """
    ref_file = tmp_path / "ref.txt"
    ref_file.write_text("the quick brown fox", encoding="utf-8")
    clip = {
        "speaker_stratum": "spk01",
        "content_domain": "general_english",
        "duration": 5.0,
        "reference": ref_file,
    }

    # 1. Failed with nonempty text: failure + 1, empty == 0, text scored
    acc1 = AccuracyAccumulator(BASE_FIXTURE_RECORD)
    acc1.record_observation(clip, {"text": "the slow brown fox", "outcome": "unexpected_failure"}, is_warmup=False)
    rep1 = acc1.to_dict(run_id="run-1")["strata"][0]
    assert rep1["trial_counts"]["measured_trials"] == 1
    assert rep1["trial_counts"]["unexpected_failures"] == 1
    assert rep1["trial_counts"]["observed_empty_count"] == 0
    words1 = rep1["modes"]["standard"]["word_scoring"]
    assert words1["scored_trials"] == 1
    assert words1["substitutions"] == 1
    assert words1["total_word_errors"] == 1

    # 2. Failed with whitespace text: failure + 1, empty + 1, scored as deletions
    acc2 = AccuracyAccumulator(BASE_FIXTURE_RECORD)
    acc2.record_observation(clip, {"text": "   \t\n", "outcome": "unexpected_failure"}, is_warmup=False)
    rep2 = acc2.to_dict(run_id="run-2")["strata"][0]
    assert rep2["trial_counts"]["measured_trials"] == 1
    assert rep2["trial_counts"]["unexpected_failures"] == 1
    assert rep2["trial_counts"]["observed_empty_count"] == 1
    words2 = rep2["modes"]["standard"]["word_scoring"]
    assert words2["scored_trials"] == 1
    assert words2["deletions"] == 4
    assert words2["total_word_errors"] == 4

    # 3. Failure with text None: failure + 1, empty == 0 (None never empty), unscored
    acc3 = AccuracyAccumulator(BASE_FIXTURE_RECORD)
    acc3.record_observation(clip, {"text": None, "outcome": "unexpected_failure"}, is_warmup=False)
    rep3 = acc3.to_dict(run_id="run-3")["strata"][0]
    assert rep3["trial_counts"]["measured_trials"] == 1
    assert rep3["trial_counts"]["unexpected_failures"] == 1
    assert rep3["trial_counts"]["observed_empty_count"] == 0
    words3 = rep3["modes"]["standard"]["word_scoring"]
    assert words3["scored_trials"] == 0
    assert words3["total_ref_words"] == 0

    # 4. Ordinary success nonempty: failure == 0, empty == 0, scored
    acc4 = AccuracyAccumulator(BASE_FIXTURE_RECORD)
    acc4.record_observation(clip, {"text": "the quick brown fox", "outcome": "success"}, is_warmup=False)
    rep4 = acc4.to_dict(run_id="run-4")["strata"][0]
    assert rep4["trial_counts"]["measured_trials"] == 1
    assert rep4["trial_counts"]["unexpected_failures"] == 0
    assert rep4["trial_counts"]["observed_empty_count"] == 0
    words4 = rep4["modes"]["standard"]["word_scoring"]
    assert words4["scored_trials"] == 1
    assert words4["total_word_errors"] == 0

    # 5. Ordinary success empty: failure == 0, empty == 1, scored as deletions
    acc5 = AccuracyAccumulator(BASE_FIXTURE_RECORD)
    acc5.record_observation(clip, {"text": "", "outcome": "success"}, is_warmup=False)
    rep5 = acc5.to_dict(run_id="run-5")["strata"][0]
    assert rep5["trial_counts"]["measured_trials"] == 1
    assert rep5["trial_counts"]["unexpected_failures"] == 0
    assert rep5["trial_counts"]["observed_empty_count"] == 1
    words5 = rep5["modes"]["standard"]["word_scoring"]
    assert words5["scored_trials"] == 1
    assert words5["deletions"] == 4


def test_complete_get_stratum_key_reused_minus_normalization(tmp_path):
    """Accumulator reuses complete validation_harness.get_stratum_key minus scoring_normalization."""
    ref_file = tmp_path / "ref.txt"
    ref_file.write_text("test reference content", encoding="utf-8")
    clip = {
        "speaker_stratum": "spk_custom",
        "content_domain": "technical_terms",
        "duration": 12.0,
        "reference": ref_file,
    }

    template = copy.deepcopy(BASE_FIXTURE_RECORD)
    template["build_info"].update(
        commit="a" * 40,
        artifact_name="eve-server-custom.exe",
        artifact_sha256="b" * 64,
        clean_tree=True,
    )
    template["environment"].update(
        os_build="Windows 11 23H2",
        cpu="AMD Ryzen 9 7950X",
        ram_gib=64.0,
        gpu="NVIDIA GeForce RTX 4090",
        gpu_driver="551.86",
        device_category="usb_headset",
        mic_model="Sennheiser SC 165 USB",
        acoustic_environment="quiet",
        background_noise_level="low",
        system_load="idle",
        background_load_id="bg_idle_v1",
    )
    template["configuration"].update(
        requested_model="small",
        effective_model="small",
        requested_device="cuda",
        effective_device="cuda",
        requested_compute_type="float16",
        effective_compute_type="float16",
        partials_enabled=False,
        dictation_mode="long",
        beam_size=3,
        language="en",
        runtime_settings_id="runtime_custom_v1",
    )

    observation = {"text": "test reference content", "outcome": "success"}
    record = make_record(
        template,
        clip,
        observation,
        run_id="run_custom_001",
        trial_id="trial_custom_001",
        repetition=0,
        repetitions=1,
        warmup=False,
        raw=False,
    )
    assert validate_record_dict(record) == []

    acc = AccuracyAccumulator(template)
    acc.record_trial(record, clip=clip, observation=observation)

    report = acc.to_dict(run_id="run_custom_001")
    assert report["report_type"] == "b4_accuracy_aggregate_report_v1"
    assert report["build_info"]["artifact_sha256"] == "b" * 64
    assert report["environment"]["cpu"] == "AMD Ryzen 9 7950X"
    assert report["configuration"]["dictation_mode"] == "long"

    stratum = report["strata"][0]
    expected_key = {k: v for k, v in get_stratum_key(record).to_display_dict().items() if k != "scoring_normalization"}
    assert stratum["stratum_key"] == expected_key
    assert "artifact_sha256" in stratum["stratum_key"]
    assert "mic_model" in stratum["stratum_key"]
    assert "dictation_mode" in stratum["stratum_key"]
    assert "beam_size" in stratum["stratum_key"]
    assert "measurement_policy_id" in stratum["stratum_key"]
    assert "scoring_normalization" not in stratum["stratum_key"]


def test_no_incompatible_pooling(tmp_path):
    """Trials with differing hardware, settings, or policy must form distinct strata."""
    ref_file = tmp_path / "ref.txt"
    ref_file.write_text("hello world", encoding="utf-8")
    clip = {
        "speaker_stratum": "spk01",
        "content_domain": "general_english",
        "duration": 4.0,
        "reference": ref_file,
    }

    template1 = copy.deepcopy(BASE_FIXTURE_RECORD)
    template1["configuration"]["beam_size"] = 1

    template2 = copy.deepcopy(BASE_FIXTURE_RECORD)
    template2["configuration"]["beam_size"] = 5

    acc = AccuracyAccumulator(template1)

    rec1 = make_record(template1, clip, {"text": "hello world", "outcome": "success"},
                       run_id="r1", trial_id="t1", repetition=0, repetitions=1, warmup=False, raw=False)
    rec2 = make_record(template2, clip, {"text": "hello world", "outcome": "success"},
                       run_id="r1", trial_id="t2", repetition=0, repetitions=1, warmup=False, raw=False)

    acc.record_trial(rec1, clip=clip, observation={"text": "hello world", "outcome": "success"})
    acc.record_trial(rec2, clip=clip, observation={"text": "hello world", "outcome": "success"})

    report = acc.to_dict(run_id="r1")
    assert len(report["strata"]) == 2, "Records with different beam_size must not be pooled into one stratum"


def test_warmup_exclusion(tmp_path):
    """Warmup trials are excluded from measured denominators, error rates, and S/D/I decompositions."""
    ref_file = tmp_path / "ref.txt"
    ref_file.write_text("hello world", encoding="utf-8")
    clip = {
        "speaker_stratum": "spk01",
        "content_domain": "general_english",
        "duration": 5.0,
        "reference": ref_file,
    }
    acc = AccuracyAccumulator(BASE_FIXTURE_RECORD)

    # Warmup with errors
    acc.record_observation(clip, {"text": "completely wrong words", "outcome": "success"}, is_warmup=True)
    # Measured with 0 errors
    acc.record_observation(clip, {"text": "hello world", "outcome": "success"}, is_warmup=False)

    report = acc.to_dict(run_id="warmup-run")
    counts = report["strata"][0]["trial_counts"]
    assert counts["total_attempts"] == 2
    assert counts["warmups_excluded"] == 1
    assert counts["measured_trials"] == 1

    std_words = report["strata"][0]["modes"]["standard"]["word_scoring"]
    assert std_words["scored_trials"] == 1
    assert std_words["total_word_errors"] == 0
    assert std_words["wer"] == 0.0


def test_exactly_same_observation_recorded_for_both_modes(tmp_path):
    """A single observation text is evaluated once for both raw and standard modes with identical sample counts."""
    ref_file = tmp_path / "ref.txt"
    ref_file.write_text("Hello, World!", encoding="utf-8")
    clip = {
        "speaker_stratum": "spk01",
        "content_domain": "general_english",
        "duration": 3.0,
        "reference": ref_file,
    }
    acc = AccuracyAccumulator(BASE_FIXTURE_RECORD)
    acc.record_observation(clip, {"text": "hello world", "outcome": "success"}, is_warmup=False)

    report = acc.to_dict(run_id="same-obs-run")
    stratum = report["strata"][0]
    raw = stratum["modes"]["raw"]["word_scoring"]
    std = stratum["modes"]["standard"]["word_scoring"]

    assert raw["scored_trials"] == std["scored_trials"] == 1
    assert raw["total_ref_words"] == std["total_ref_words"] == 2
    assert raw["total_word_errors"] > 0
    assert std["total_word_errors"] == 0


def test_output_aggregate_contains_no_input_speech_text_and_preserves_privacy(tmp_path):
    """Aggregate reports MUST NOT persist or log any spoken reference or hypothesis text."""
    secret_ref = "SECRET_UNPUBLISHED_AUDIO_CONTENT_CONFIDENTIAL"
    secret_hyp = "SECRET_RECOGNIZED_TRANSCRIPT_DO_NOT_PERSIST"

    ref_file = tmp_path / "secret_ref.txt"
    ref_file.write_text(secret_ref, encoding="utf-8")
    clip = {
        "speaker_stratum": "spk01",
        "content_domain": "general_english",
        "duration": 4.0,
        "reference": ref_file,
    }
    acc = AccuracyAccumulator(BASE_FIXTURE_RECORD)
    acc.record_observation(clip, {"text": secret_hyp, "outcome": "success"}, is_warmup=False)

    report = acc.to_dict(run_id="privacy-run")
    serialized = json.dumps(report)

    assert secret_ref not in serialized
    assert secret_hyp not in serialized
    assert "SECRET" not in serialized
    assert "CONFIDENTIAL" not in serialized
    assert report["policy_metadata"]["privacy_guarantee"] == "no_speech_or_transcript_text_persisted"
    assert report["critical_entity_review_availability"] is False


def _make_test_manifest(tmp_path):
    audio_path = tmp_path / "clip.wav"
    with wave.open(str(audio_path), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\0\0" * 1600)  # 0.1s

    ref_path = tmp_path / "clip.txt"
    ref_path.write_text("The quick brown fox", encoding="utf-8")

    record_template = copy.deepcopy(BASE_FIXTURE_RECORD)
    record_template["build_info"].update(commit="1" * 40, artifact_sha256="2" * 64, clean_tree=True)
    record_template["trial_metadata"].update(evidence_type="replay", warmup_policy="one_excluded_per_clip")

    manifest = {
        "record": record_template,
        "clips": [{
            "audio": "clip.wav",
            "reference": "clip.txt",
            "speaker_stratum": "spk_integration",
            "content_domain": "general_english",
        }],
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return manifest_path, audio_path, ref_path


@pytest.mark.asyncio
async def test_accuracy_output_existing_fails_before_network_and_leaves_bytes_unchanged(tmp_path):
    """If accuracy_output already exists, fail before network or output mutation; existing bytes unchanged."""
    manifest_path, _, _ = _make_test_manifest(tmp_path)
    existing_sidecar = tmp_path / "existing_sidecar.json"
    original_bytes = b"PREEXISTING_EVIDENCE_DO_NOT_TOUCH_12345"
    existing_sidecar.write_bytes(original_bytes)

    primary_output = tmp_path / "primary_output.ndjson"

    class Args:
        manifest = str(manifest_path)
        output = str(primary_output)
        accuracy_output = str(existing_sidecar)
        url = "ws://127.0.0.1:51717/transcribe"
        repetitions = 1
        timeout = 10.0
        raw = False

    replay_called = False

    async def mock_replay(*args, **kwargs):
        nonlocal replay_called
        replay_called = True
        return {"first_partial_ms": 1.0, "stop_to_final_text_ms": 2.0, "last_audio_ms": 1.0,
                "server_perf": None, "text": "hello", "outcome": "success"}

    with patch("scripts.perf_regression_benchmark.replay_trial", side_effect=mock_replay):
        with pytest.raises(FileExistsError):
            await run_replay(Args())

    assert existing_sidecar.read_bytes() == original_bytes, "Existing sidecar bytes must remain untouched"
    assert not primary_output.exists(), "Primary output must not be created when preflight check fails"
    assert not replay_called, "No replay must be called when accuracy_output preflight check fails"


@pytest.mark.asyncio
async def test_accuracy_output_path_collision_rejected_before_network(tmp_path):
    """Accuracy output collision with primary output, manifest, audio, or reference is rejected before network."""
    manifest_path, audio_path, ref_path = _make_test_manifest(tmp_path)
    primary_output = tmp_path / "primary_output.ndjson"

    class Args:
        manifest = str(manifest_path)
        output = str(primary_output)
        accuracy_output = None
        url = "ws://127.0.0.1:51717/transcribe"
        repetitions = 1
        timeout = 10.0
        raw = False

    replay_called = False

    async def mock_replay(*args, **kwargs):
        nonlocal replay_called
        replay_called = True
        return {}

    with patch("scripts.perf_regression_benchmark.replay_trial", side_effect=mock_replay):
        # 1. Collides with output
        Args.accuracy_output = str(primary_output)
        with pytest.raises(ValueError, match="collides with primary output"):
            await run_replay(Args())
        assert not replay_called

        # 2. Collides with manifest
        Args.accuracy_output = str(manifest_path)
        with pytest.raises(ValueError, match="collides with manifest"):
            await run_replay(Args())
        assert not replay_called

        # 3. Collides with audio
        Args.accuracy_output = str(audio_path)
        with pytest.raises(ValueError, match="collides with clip 0 audio"):
            await run_replay(Args())
        assert not replay_called

        # 4. Collides with reference
        Args.accuracy_output = str(ref_path)
        with pytest.raises(ValueError, match="collides with clip 0 reference"):
            await run_replay(Args())
        assert not replay_called

        # 5. Case alias collision on Windows
        if os.name == "nt":
            Args.accuracy_output = str(primary_output).upper()
            with pytest.raises(ValueError, match="collides with primary output"):
                await run_replay(Args())
            assert not replay_called


@pytest.mark.asyncio
async def test_partial_execution_does_not_emit_falsely_complete_report(tmp_path):
    """If replay fails partially, the reserved sidecar remains explicitly incomplete."""
    manifest_path, _, _ = _make_test_manifest(tmp_path)
    primary_output = tmp_path / "partial_output.ndjson"
    sidecar_path = tmp_path / "sidecar.json"

    class Args:
        manifest = str(manifest_path)
        output = str(primary_output)
        accuracy_output = str(sidecar_path)
        url = "ws://127.0.0.1:51717/transcribe"
        repetitions = 1
        timeout = 10.0
        raw = False

    call_count = 0

    async def mock_replay(*args, **kwargs):
        return {"first_partial_ms": 1.0, "stop_to_final_text_ms": 2.0, "last_audio_ms": 1.0,
                "server_perf": None, "text": "hello", "outcome": "success"}

    orig_make_record = make_record

    def mock_make_record(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count > 1:
            raise RuntimeError("Simulated execution failure during replay loop")
        return orig_make_record(*args, **kwargs)

    with patch("scripts.perf_regression_benchmark.replay_trial", side_effect=mock_replay):
        with patch("scripts.perf_regression_benchmark.make_record", side_effect=mock_make_record):
            with pytest.raises(RuntimeError, match="Simulated execution failure"):
                await run_replay(Args())

    assert json.loads(sidecar_path.read_text())["report_status"] == "incomplete"


@pytest.mark.asyncio
async def test_primary_trial_records_survive_sidecar_error(tmp_path):
    """Primary trial records must survive even if sidecar report generation or writing fails."""
    manifest_path, _, _ = _make_test_manifest(tmp_path)
    primary_output = tmp_path / "surviving_output.ndjson"
    sidecar_path = tmp_path / "failing_sidecar.json"

    class Args:
        manifest = str(manifest_path)
        output = str(primary_output)
        accuracy_output = str(sidecar_path)
        url = "ws://127.0.0.1:51717/transcribe"
        repetitions = 1
        timeout = 10.0
        raw = False

    async def mock_replay(*args, **kwargs):
        return {"first_partial_ms": 1.0, "stop_to_final_text_ms": 2.0, "last_audio_ms": 1.0,
                "server_perf": None, "text": "The quick brown fox", "outcome": "success"}

    with patch("scripts.perf_regression_benchmark.replay_trial", side_effect=mock_replay):
        with patch.object(AccuracyAccumulator, "to_dict", side_effect=RuntimeError("Sidecar formatting crashed")):
            with pytest.raises(RuntimeError, match="Sidecar formatting crashed"):
                await run_replay(Args())

    assert primary_output.exists(), "Primary trial records file must survive sidecar error"
    lines = primary_output.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    for line in lines:
        rec = json.loads(line)
        assert validate_record_dict(rec) == []


@pytest.mark.asyncio
async def test_default_record_write_unchanged(tmp_path):
    """Replay without --accuracy-output writes default output identically conforming to shared schema."""
    manifest_path, _, _ = _make_test_manifest(tmp_path)
    primary_output = tmp_path / "default_run_output.ndjson"

    class Args:
        manifest = str(manifest_path)
        output = str(primary_output)
        accuracy_output = None
        url = "ws://127.0.0.1:51717/transcribe"
        repetitions = 1
        timeout = 10.0
        raw = False

    async def mock_replay(*args, **kwargs):
        return {"first_partial_ms": 1.0, "stop_to_final_text_ms": 2.0, "last_audio_ms": 1.0,
                "server_perf": None, "text": "The quick brown fox", "outcome": "success"}

    with patch("scripts.perf_regression_benchmark.replay_trial", side_effect=mock_replay):
        await run_replay(Args())

    assert primary_output.exists()
    lines = primary_output.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    for line in lines:
        rec = json.loads(line)
        assert validate_record_dict(rec) == []


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', [None, 'write', 'flush', 'sync', 'replace', 'interrupt'])
async def test_sidecar_publication_preserves_incomplete_on_io_failure(tmp_path, failure):
    manifest_path, _, _ = _make_test_manifest(tmp_path)
    primary = tmp_path / 'trials.ndjson'
    sidecar = tmp_path / 'accuracy.json'

    class Args:
        manifest = str(manifest_path)
        output = str(primary)
        accuracy_output = str(sidecar)
        url = 'ws://127.0.0.1:51717/transcribe'
        repetitions = 1
        timeout = 10.0
        raw = False

    async def replay(*args, **kwargs):
        return {'first_partial_ms': 1.0, 'stop_to_final_text_ms': 2.0, 'last_audio_ms': 1.0,
                'server_perf': None, 'text': 'The quick brown fox', 'outcome': 'success'}

    original_open = io.open

    class FaultyReportFile:
        def __init__(self, sink):
            self.sink = sink
            self.aggregate_written = False

        def __getattr__(self, name):
            return getattr(self.sink, name)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return self.sink.__exit__(*args)

        def write(self, data):
            aggregate = isinstance(data, str) and '"report_type"' in data
            if aggregate and failure == 'write':
                self.sink.write(data[:8])
                self.sink.flush()
                raise OSError('synthetic partial report write')
            result = self.sink.write(data)
            self.aggregate_written |= aggregate
            return result

        def flush(self):
            self.sink.flush()
            if self.aggregate_written and failure == 'flush':
                raise OSError('synthetic report flush')

    with ExitStack() as stack:
        stack.enter_context(patch('scripts.perf_regression_benchmark.replay_trial', side_effect=replay))
        stack.enter_context(patch('io.open', side_effect=lambda *a, **kw: FaultyReportFile(original_open(*a, **kw))))
        if failure in {'sync', 'replace', 'interrupt'}:
            operation = 'replace' if failure == 'replace' else 'fsync'
            error = KeyboardInterrupt if failure == 'interrupt' else OSError
            stack.enter_context(patch(f'scripts.perf_regression_benchmark.os.{operation}',
                                      side_effect=error(f'synthetic report {failure}')))
        if failure is None:
            await run_replay(Args())
        else:
            with pytest.raises(KeyboardInterrupt if failure == 'interrupt' else OSError, match='synthetic'):
                await run_replay(Args())

    assert json.loads(sidecar.read_text())['report_status'] == ('complete' if failure is None else 'incomplete')
    records = [json.loads(line) for line in primary.read_text().splitlines()]
    assert len(records) == 2 and all(validate_record_dict(record) == [] for record in records)
    assert not list(tmp_path.glob('.accuracy.json.*.tmp'))
