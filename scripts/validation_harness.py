# Eve B4 offline validation, scoring, and reporting harness (Python stdlib).
from __future__ import annotations
import argparse, copy, dataclasses, json, math, os, re, sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple
SCHEMA_VERSION = "1.0.0"
HEX_40_REGEX, HEX_64_REGEX = re.compile(r"^[0-9a-f]{40}$"), re.compile(r"^[0-9a-f]{64}$")
ID_REGEX, ISO8601_REGEX = re.compile(r"^[a-zA-Z0-9_\-\.]{1,64}$"), re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
PUNCT_REGEX, WHITESPACE_REGEX = re.compile(r"[^\w\s]"), re.compile(r"\s+")
ALLOWED_DEVICE_CATEGORIES: Set[str] = {"laptop_built_in", "usb_headset", "analog_headset", "bluetooth_headset", "external_desktop_mic", "virtual_loopback"}
ALLOWED_ACOUSTIC_ENVIRONMENTS: Set[str] = {"quiet", "moderate_noise"}
ALLOWED_SYSTEM_LOADS: Set[str] = {"idle", "moderate", "heavy"}
ALLOWED_DICTATION_MODES: Set[str] = {"quick", "long"}
ALLOWED_EVIDENCE_TYPES: Set[str] = {"physical_microphone", "replay", "synthetic"}
ALLOWED_CONTENT_DOMAINS: Set[str] = {"general_english", "names_numbers_dates", "technical_terms", "edge_case"}
ALLOWED_EDGE_CASES: Set[str] = {"silence", "empty", "mic_unavailable", "disconnect", "recovery"}
ALLOWED_OUTCOMES: Set[str] = {"success", "expected_failure_handled", "unexpected_failure"}
ALLOWED_HUMAN_ASSESSMENTS: Set[str] = {"exact_match", "minor_punctuation", "usable", "critical_error", "unusable", "not_assessed", "handled_expected_failure"}
DISALLOWED_MIC_NAMES: Set[str] = {"generic", "default", "unknown", "unspecified", "mic", "microphone"}
TIMING_FIELDS: List[str] = [
    "mic_open_ms", "first_partial_ms", "vad_speech_start_ms", "vad_speech_end_ms", "stop_request_ms", "last_audio_ms",
    "queue_wait_ms", "model_inference_ms", "final_to_display_ms", "final_to_history_ms", "clipboard_write_ms", "actual_insertion_ms", "stop_to_final_text_ms",
]
class ValidationError(ValueError): pass
class IncompatiblePoolingError(ValueError): pass
SCHEMA: Dict[str, Any] = {
    "schema_version": ("eq", SCHEMA_VERSION),
    "run_id": ("regex", ID_REGEX, "must be an alphanumeric identifier (1-64 chars)"),
    "timestamp": "iso8601",
    "build_info": {"commit": "hex40", "artifact_name": "str", "artifact_sha256": "hex64", "clean_tree": "bool"},
    "environment": {
        "os_build": "str", "cpu": "str", "ram_gib": "pos_num", "gpu": "str", "gpu_driver": "str",
        "device_category": ("enum", ALLOWED_DEVICE_CATEGORIES), "mic_model": "mic_model",
        "acoustic_environment": ("enum", ALLOWED_ACOUSTIC_ENVIRONMENTS),
        "background_noise_level": "str", "system_load": ("enum", ALLOWED_SYSTEM_LOADS),
        "background_load_id": "str",
    },
    "configuration": {
        "requested_model": "str", "effective_model": "str", "requested_device": ("enum", {"cpu", "cuda", "auto"}),
        "effective_device": ("enum", {"cpu", "cuda"}), "requested_compute_type": "str", "effective_compute_type": "str",
        "partials_enabled": "bool", "dictation_mode": ("enum", ALLOWED_DICTATION_MODES), "beam_size": "pos_int", "language": "str",
        "runtime_settings_id": "str",
    },
    "trial_metadata": {
        "trial_id": "str", "corpus_id": "str", "warmup_policy": "str", "evidence_type": ("enum", ALLOWED_EVIDENCE_TYPES),
        "speaker_stratum": "str", "content_domain": ("enum", ALLOWED_CONTENT_DOMAINS),
        "edge_case_type": ("nullable", ("enum", ALLOWED_EDGE_CASES)), "is_warmup": "bool",
        "repetition_index": "non_neg_int", "total_repetitions": "pos_int", "audio_duration_seconds": "non_neg_num",
    },
    "stage_timings": {"timing_clock_domain": "str", "measurement_policy_id": "str", **{tf: ("nullable", "non_neg_num") for tf in TIMING_FIELDS}},
    "rates": {rf: ("nullable", "non_neg_num") for rf in ["real_time_factor", "processing_speed_ratio", "words_per_second"]},
    "resources": {rf: ("nullable", "num" if rf == "gpu_vram_delta_mib" else "non_neg_num") for rf in ["server_peak_rss_mib", "server_settled_rss_mib", "app_peak_rss_mib", "cpu_process_percent", "gpu_vram_delta_mib"]},
    "evaluation": {
        "scoring_normalization": ("enum", {"standard", "raw"}), "output_empty": "bool", "expected_speech": "bool",
        "outcome": ("enum", ALLOWED_OUTCOMES), "human_assessment": ("nullable", ("enum", ALLOWED_HUMAN_ASSESSMENTS)),
        "reference_word_count": ("nullable", "non_neg_int"), "word_errors": ("nullable", "non_neg_int"),
        "wer": ("nullable", "non_neg_num"), "wer_fraction": ("nullable", "str"),
        "reference_char_count": ("nullable", "non_neg_int"), "char_errors": ("nullable", "non_neg_int"),
        "cer": ("nullable", "non_neg_num"), "cer_fraction": ("nullable", "str"),
        "critical_entity_errors": ("nullable", "non_neg_int"),
    },
}
def validate_spec(val: Any, spec: Any, path: str, errors: List[str]) -> None:
    if isinstance(spec, dict):
        if not isinstance(val, dict):
            errors.append(f"Field '{path}': must be an object" if path else "Root: must be an object"); return
        if any(k not in spec for k in val.keys()):
            errors.append(f"Field '{path}': unrecognized field detected" if path else "Root: unrecognized field detected")
        for k, sub in spec.items(): validate_spec(val.get(k), sub, f"{path}.{k}" if path else k, errors)
        return
    if isinstance(spec, tuple):
        t = spec[0]
        if t == "nullable":
            if val is not None: validate_spec(val, spec[1], path, errors)
        elif t == "enum":
            if not isinstance(val, str) or val not in spec[1]: errors.append(f"Field '{path}': invalid value")
        elif t == "eq" and val != spec[1]:
            errors.append(f"Field '{path}': invalid version string" if path == "schema_version" else f"Field '{path}': value mismatch")
        elif t == "regex" and (not isinstance(val, str) or not spec[1].match(val)):
            errors.append(f"Field '{path}': {spec[2]}")
        return
    rules = {
        "bool": (lambda v: isinstance(v, bool), "must be a boolean"),
        "pos_num": (lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and v > 0, "must be a positive number"),
        "non_neg_num": (lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and v >= 0, "must be a non-negative number"),
        "num": (lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v), "must be a finite number"),
        "pos_int": (lambda v: not isinstance(v, bool) and isinstance(v, int) and v > 0, "must be a positive integer"),
        "non_neg_int": (lambda v: not isinstance(v, bool) and isinstance(v, int) and v >= 0, "must be a non-negative integer"),
        "hex40": (lambda v: isinstance(v, str) and bool(HEX_40_REGEX.match(v)), "must be exact 40-character lowercase hex string"),
        "hex64": (lambda v: isinstance(v, str) and bool(HEX_64_REGEX.match(v)), "must be exact 64-character lowercase hex string"),
        "iso8601": (lambda v: isinstance(v, str) and bool(ISO8601_REGEX.match(v)), "must be ISO 8601 UTC string"),
    }
    if spec in rules:
        chk, msg = rules[spec]
        if not chk(val): errors.append(f"Field '{path}': {msg}")
    elif spec == "str":
        if not isinstance(val, str) or not val.strip() or len(val) > 256 or any(ord(c) < 32 or ord(c) == 127 for c in val):
            errors.append(f"Field '{path}': must be a valid bounded sanitized string")
    elif spec == "mic_model":
        if not isinstance(val, str) or not val.strip() or len(val) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in val):
            errors.append(f"Field '{path}': must be a valid sanitized string")
        elif val.strip().lower() in DISALLOWED_MIC_NAMES:
            errors.append(f"Field '{path}': generic placeholder names are not permitted")
def _check_rate(ev: Dict[str, Any], r_k: str, e_k: str, rate_k: str, frac_k: str, errors: List[str]) -> None:
    rc, ec, rate, frac = ev.get(r_k), ev.get(e_k), ev.get(rate_k), ev.get(frac_k)
    if rc is None or rc == 0 or ec is None:
        if rate is not None: errors.append(f"Field 'evaluation.{rate_k}': must be null when unscored")
        if frac is not None: errors.append(f"Field 'evaluation.{frac_k}': must be null when unscored")
    else:
        if not isinstance(rate, (int, float)) or isinstance(rate, bool) or not math.isfinite(rate) or rate < 0:
            errors.append(f"Field 'evaluation.{rate_k}': must be a non-negative number")
        elif abs(rate - (ec / rc)) > 1e-4:
            errors.append(f"Field 'evaluation.{rate_k}': does not match {e_k} / {r_k}")
        if frac not in (f"{ec}/{rc}", f"{ec}/{rc} = {ec / rc:.1%}"):
            errors.append(f"Field 'evaluation.{frac_k}': invalid fraction string")
def validate_record_dict(rec: Any) -> List[str]:
    errors: List[str] = []
    if not isinstance(rec, dict): return ["Root: record must be a JSON object"]
    validate_spec(rec, SCHEMA, "", errors)
    tm = rec.get("trial_metadata")
    if isinstance(tm, dict):
        rep, tot = tm.get("repetition_index"), tm.get("total_repetitions")
        if isinstance(rep, int) and isinstance(tot, int) and not isinstance(rep, bool) and not isinstance(tot, bool) and rep >= tot:
            errors.append("Field 'trial_metadata.repetition_index': must be strictly less than total_repetitions")
    ev = rec.get("evaluation")
    if isinstance(ev, dict) and not errors:
        _check_rate(ev, "reference_word_count", "word_errors", "wer", "wer_fraction", errors)
        _check_rate(ev, "reference_char_count", "char_errors", "cer", "cer_fraction", errors)
    return errors
def get_duration_bin(duration_s: float) -> str:
    if duration_s < 5.0: return "quick_<5s"
    elif duration_s <= 15.0: return "standard_5-15s"
    elif duration_s <= 30.0: return "medium_15-30s"
    return "long_>30s"
@dataclasses.dataclass(frozen=True)
class StratumKey:
    commit: str; artifact_name: str; artifact_sha256: str; os_build: str; cpu: str
    ram_gib: float; gpu: str; gpu_driver: str; device_category: str; mic_model: str
    acoustic_environment: str; background_noise_level: str; system_load: str
    requested_model: str; effective_model: str; requested_device: str; effective_device: str
    requested_compute_type: str; effective_compute_type: str; partials_enabled: bool
    dictation_mode: str; beam_size: int; language: str; corpus_id: str; warmup_policy: str
    evidence_type: str; speaker_stratum: str; content_domain: str; edge_case_type: Optional[str]
    duration_bin: str; scoring_normalization: str
    background_load_id: str; runtime_settings_id: str; measurement_policy_id: str
    def to_display_dict(self) -> Dict[str, Any]: return dataclasses.asdict(self)
def get_stratum_key(rec: Dict[str, Any]) -> StratumKey:
    b, e, c, t, ev = rec["build_info"], rec["environment"], rec["configuration"], rec["trial_metadata"], rec["evaluation"]
    return StratumKey(
        commit=b["commit"], artifact_name=b["artifact_name"], artifact_sha256=b["artifact_sha256"],
        os_build=e["os_build"], cpu=e["cpu"], ram_gib=float(e["ram_gib"]), gpu=e["gpu"], gpu_driver=e["gpu_driver"],
        device_category=e["device_category"], mic_model=e["mic_model"], acoustic_environment=e["acoustic_environment"],
        background_noise_level=e["background_noise_level"], system_load=e["system_load"],
        requested_model=c["requested_model"], effective_model=c["effective_model"], requested_device=c["requested_device"],
        effective_device=c["effective_device"], requested_compute_type=c["requested_compute_type"],
        effective_compute_type=c["effective_compute_type"], partials_enabled=bool(c["partials_enabled"]),
        dictation_mode=c["dictation_mode"], beam_size=int(c["beam_size"]), language=c["language"],
        corpus_id=t["corpus_id"], warmup_policy=t["warmup_policy"], evidence_type=t["evidence_type"],
        speaker_stratum=t["speaker_stratum"], content_domain=t["content_domain"], edge_case_type=t.get("edge_case_type"),
        duration_bin=get_duration_bin(float(t["audio_duration_seconds"])), scoring_normalization=ev.get("scoring_normalization", "standard"),
        background_load_id=e["background_load_id"], runtime_settings_id=c["runtime_settings_id"],
        measurement_policy_id=rec["stage_timings"]["measurement_policy_id"],
    )
def check_pooling_compatibility(records: Sequence[Dict[str, Any]]) -> None:
    if len(records) <= 1: return
    k0 = get_stratum_key(records[0])
    differing = [f.name for f in dataclasses.fields(StratumKey) if any(getattr(k0, f.name) != getattr(get_stratum_key(r), f.name) for r in records[1:])]
    if differing: raise IncompatiblePoolingError(f"Incompatible pooling: records differ in stratum dimensions: {differing}")
def nearest_rank_percentile(values: Sequence[float], p: float) -> Optional[float]:
    if not values: return None
    if not (0.0 <= p <= 100.0) or math.isnan(p) or math.isinf(p): raise ValueError("Invalid percentile")
    for v in values:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v): raise ValueError("Values must be finite numbers")
    sorted_vals = sorted(values)
    rank = math.ceil((p / 100.0) * len(sorted_vals))
    return float(sorted_vals[max(0, min(rank - 1, len(sorted_vals) - 1))])
def levenshtein_distance(seq1: Sequence[Any], seq2: Sequence[Any]) -> int:
    if not seq1 or not seq2: return len(seq1) or len(seq2)
    dp = list(range(len(seq2) + 1))
    for i, item1 in enumerate(seq1, 1):
        prev = dp[0]; dp[0] = i
        for j, item2 in enumerate(seq2, 1):
            cur = min(dp[j] + 1, dp[j - 1] + 1, prev + (0 if item1 == item2 else 1))
            prev = dp[j]; dp[j] = cur
    return dp[-1]
def normalize_text(text: str) -> str:
    return WHITESPACE_REGEX.sub(" ", PUNCT_REGEX.sub(" ", text.lower())).strip()
def compute_wer(ref_text: str, hyp_text: str, normalize: bool = True) -> Tuple[int, int, Optional[float], Optional[str]]:
    r_words = (normalize_text(ref_text) if normalize else ref_text.strip()).split()
    h_words = (normalize_text(hyp_text) if normalize else hyp_text.strip()).split()
    if not r_words: return 0, 0, None, None
    errs = levenshtein_distance(r_words, h_words)
    wer = errs / len(r_words)
    return errs, len(r_words), wer, f"{errs}/{len(r_words)} = {wer:.1%}"
def compute_cer(ref_text: str, hyp_text: str, normalize: bool = True) -> Tuple[int, int, Optional[float], Optional[str]]:
    r_chars = [c for c in (normalize_text(ref_text) if normalize else ref_text.strip()) if not c.isspace()]
    h_chars = [c for c in (normalize_text(hyp_text) if normalize else hyp_text.strip()) if not c.isspace()]
    if not r_chars: return 0, 0, None, None
    errs = levenshtein_distance(r_chars, h_chars)
    cer = errs / len(r_chars)
    return errs, len(r_chars), cer, f"{errs}/{len(r_chars)} = {cer:.1%}"

@dataclasses.dataclass
class TimingSummary:
    observed_count: int; p50_ms: Optional[float]; p95_ms: Optional[float]

@dataclasses.dataclass
class StratumSummary:
    key: StratumKey; total_attempts: int; warmups_excluded: int; measured_trials: int
    unexpected_failures: int; unexpected_failure_rate: Optional[float]
    empty_results_count: int; expected_speech_trials: int
    empty_on_expected_speech_count: int; empty_on_expected_speech_rate: Optional[float]
    scored_word_trials_count: int; total_word_errors: Optional[int]; total_ref_words: int
    pooled_wer: Optional[float]; wer_fraction: str
    scored_char_trials_count: int; total_char_errors: Optional[int]; total_ref_chars: int
    pooled_cer: Optional[float]; cer_fraction: str
    critical_entity_errors_count: Optional[int]; timings: Dict[str, TimingSummary]
    def to_dict(self) -> Dict[str, Any]:
        d = dataclasses.asdict(self)
        d["stratum_key"] = self.key.to_display_dict()
        return d

def _score_pool(measured: Sequence[Dict[str, Any]], err_k: str, ref_k: str) -> Tuple[int, Optional[int], int, Optional[float], str]:
    scored = [r for r in measured if r["evaluation"].get(err_k) is not None and (r["evaluation"].get(ref_k) or 0) > 0]
    n = len(scored)
    tot_err = sum(r["evaluation"][err_k] for r in scored) if n else None
    tot_ref = sum(r["evaluation"][ref_k] for r in scored) if n else 0
    pooled = (tot_err / tot_ref) if tot_ref > 0 else None
    return n, tot_err, tot_ref, pooled, (f"{tot_err}/{tot_ref} = {pooled:.1%}" if pooled is not None else "unavailable")

def summarize_stratum(key: StratumKey, records: Sequence[Dict[str, Any]]) -> StratumSummary:
    for r in records:
        if validate_record_dict(r): raise ValidationError("Record violates schema constraints")
        if get_stratum_key(r) != key: raise IncompatiblePoolingError("Incompatible pooling: record does not match stratum key")
    total_attempts = len(records)
    warmups = [r for r in records if r["trial_metadata"]["is_warmup"]]
    measured = [r for r in records if not r["trial_metadata"]["is_warmup"]]
    meas_n = len(measured)
    unexp = sum(1 for r in measured if r["evaluation"]["outcome"] == "unexpected_failure")
    unexp_rate = (unexp / meas_n) if meas_n > 0 else None
    empty_cnt = sum(1 for r in measured if r["evaluation"]["output_empty"])
    exp_speech = [r for r in measured if r["evaluation"]["expected_speech"]]
    exp_n = len(exp_speech)
    empty_exp = sum(1 for r in exp_speech if r["evaluation"]["output_empty"])
    empty_exp_rate = (empty_exp / exp_n) if exp_n > 0 else None
    sw_cnt, tot_w_err, tot_r_word, p_wer, w_frac = _score_pool(measured, "word_errors", "reference_word_count")
    sc_cnt, tot_c_err, tot_r_char, p_cer, c_frac = _score_pool(measured, "char_errors", "reference_char_count")
    crit = [r["evaluation"]["critical_entity_errors"] for r in measured if r["evaluation"].get("critical_entity_errors") is not None]
    tot_crit = sum(crit) if crit else None
    timings: Dict[str, TimingSummary] = {}
    for tk in TIMING_FIELDS:
        vals = [float(r["stage_timings"][tk]) for r in measured if r.get("stage_timings") and r["stage_timings"].get(tk) is not None]
        timings[tk] = TimingSummary(
            observed_count=len(vals),
            p50_ms=nearest_rank_percentile(vals, 50.0) if vals else None,
            p95_ms=nearest_rank_percentile(vals, 95.0) if vals else None,
        )
    return StratumSummary(
        key=key, total_attempts=total_attempts, warmups_excluded=len(warmups), measured_trials=meas_n,
        unexpected_failures=unexp, unexpected_failure_rate=unexp_rate, empty_results_count=empty_cnt,
        expected_speech_trials=exp_n, empty_on_expected_speech_count=empty_exp, empty_on_expected_speech_rate=empty_exp_rate,
        scored_word_trials_count=sw_cnt, total_word_errors=tot_w_err, total_ref_words=tot_r_word,
        pooled_wer=p_wer, wer_fraction=w_frac, scored_char_trials_count=sc_cnt, total_char_errors=tot_c_err,
        total_ref_chars=tot_r_char, pooled_cer=p_cer, cer_fraction=c_frac, critical_entity_errors_count=tot_crit,
        timings=timings,
    )

def stratify_and_summarize(records: Sequence[Dict[str, Any]]) -> List[StratumSummary]:
    for r in records:
        if validate_record_dict(r): raise ValidationError("Record violates schema constraints")
    groups: Dict[StratumKey, List[Dict[str, Any]]] = {}
    for r in records: groups.setdefault(get_stratum_key(r), []).append(r)
    return [summarize_stratum(k, grp) for k, grp in groups.items()]

def format_ms(val: Optional[float]) -> str:
    return "-" if val is None else f"{val:.1f} ms"
def format_summary_markdown(summaries: Sequence[StratumSummary]) -> str:
    lines = ["# Eve B4 Validation Stratified Summary Report", "", f"Total strata: {len(summaries)}", ""]
    for idx, s in enumerate(summaries, 1):
        k = s.key
        lines.extend([
            f"## Stratum {idx}: {k.evidence_type} | {k.effective_model} ({k.effective_device}/{k.effective_compute_type}) | {k.device_category}",
            "", "### Stratum Identification & Provenance",
            f"- **Commit**: `{k.commit}`", f"- **Artifact**: `{k.artifact_name}` (`{k.artifact_sha256}`)",
            f"- **Hardware**: `{k.cpu}` | RAM: {k.ram_gib:.1f} GiB | GPU: `{k.gpu}` (`{k.gpu_driver}`)", f"- **OS**: `{k.os_build}`",
            f"- **Environment**: Mic: `{k.mic_model}` ({k.device_category}) | Acoustic: `{k.acoustic_environment}` (Noise: `{k.background_noise_level}`) | Load: `{k.system_load}`",
            f"- **Configuration**: Model: `{k.requested_model}` -> `{k.effective_model}` | Device: `{k.requested_device}` -> `{k.effective_device}` ({k.effective_compute_type}) | Partials: {k.partials_enabled} | Mode: `{k.dictation_mode}` | Beam: {k.beam_size} | Lang: `{k.language}`",
            f"- **Trial Context**: Corpus: `{k.corpus_id}` | Warmup policy: `{k.warmup_policy}` | Speaker: `{k.speaker_stratum}` | Domain: `{k.content_domain}` | Duration bin: `{k.duration_bin}` | Edge: `{k.edge_case_type or 'none'}`",
            f"- **Scoring Normalization**: `{k.scoring_normalization}`",
            f"- **Policies**: Load `{k.background_load_id}` | Runtime `{k.runtime_settings_id}` | Measurement `{k.measurement_policy_id}`",
            "", "### Execution & Quality Summary",
            "| Metric | Value |", "| :--- | :--- |",
            f"| Total attempts | {s.total_attempts} |", f"| Warmups excluded | {s.warmups_excluded} |",
            f"| Measured trials | {s.measured_trials} |", f"| Scored word trials (n) | {s.scored_word_trials_count} |",
            f"| Word Error Rate (WER) | {'unavailable' if s.pooled_wer is None else f'{s.pooled_wer:.1%}'} ({s.wer_fraction}) |",
            f"| Scored char trials (n) | {s.scored_char_trials_count} |",
            f"| Character Error Rate (CER) | {'unavailable' if s.pooled_cer is None else f'{s.pooled_cer:.1%}'} ({s.cer_fraction}) |",
            f"| Critical entity errors | {s.critical_entity_errors_count if s.critical_entity_errors_count is not None else 'unassessed'} |",
            f"| Empty results count | {s.empty_results_count} |",
            f"| Empty-on-expected-speech rate | {'unavailable' if s.empty_on_expected_speech_rate is None else f'{s.empty_on_expected_speech_rate:.1%} ({s.empty_on_expected_speech_count}/{s.expected_speech_trials})'} |",
            f"| Unexpected failure rate | {'unavailable' if s.unexpected_failure_rate is None else f'{s.unexpected_failure_rate:.1%} ({s.unexpected_failures}/{s.measured_trials})'} |",
            "", "### Latency Stages (Descriptive)", "| Stage | Observed (n) | p50 | p95 |", "| :--- | :--- | :--- | :--- |",
        ])
        for name, ts in s.timings.items():
            lines.append(f"| `{name}` | {ts.observed_count} | {format_ms(ts.p50_ms)} | {format_ms(ts.p95_ms)} |")
        lines.append("")
    return "\n".join(lines)

def ensure_safe_external_path(path: Path) -> Path:
    for component in (path.absolute(), *path.absolute().parents):
        if component.is_symlink():
            raise ValueError("Symlink paths are rejected")
        try:
            st = os.lstat(component)
        except OSError:
            continue
        if getattr(st, "st_file_attributes", 0) & 0x400:
            raise ValueError("Reparse point paths are rejected")
    resolved = path.resolve()
    repo_root = Path(__file__).resolve().parent.parent.resolve()
    try:
        resolved.relative_to(repo_root); is_inside = True
    except ValueError: is_inside = False
    if is_inside: raise ValueError("Paths inside the repository are rejected to prevent private data exposure")
    return resolved

def load_records_file(file_path: Path) -> List[Dict[str, Any]]:
    safe_path = ensure_safe_external_path(file_path)
    if not safe_path.exists(): raise FileNotFoundError("Input file not found")
    content = safe_path.read_text(encoding="utf-8-sig").strip()
    if not content: return []
    try:
        parsed = json.loads(content)
        if isinstance(parsed, list):
            for item in parsed:
                if not isinstance(item, dict): raise ValueError("List elements must be JSON objects")
            return parsed
        elif isinstance(parsed, dict): return [parsed]
    except json.JSONDecodeError: pass
    records: List[Dict[str, Any]] = []
    for line in content.splitlines():
        line_str = line.strip()
        if not line_str: continue
        try: rec = json.loads(line_str)
        except json.JSONDecodeError: raise ValueError("Invalid JSON record format")
        if not isinstance(rec, dict): raise ValueError("NDJSON lines must be JSON objects")
        records.append(rec)
    return records

BASE_FIXTURE_RECORD: Dict[str, Any] = {
    "schema_version": SCHEMA_VERSION, "run_id": "fixture_sample_00", "timestamp": "2026-10-07T12:00:00Z",
    "build_info": {"commit": "0" * 40, "artifact_name": "FIXTURE_BUILD_NON_PRODUCT", "artifact_sha256": "0" * 64, "clean_tree": True},
    "environment": {
        "os_build": "Windows 11 Fixture Build 00000", "cpu": "FIXTURE_CPU_NON_PRODUCT", "ram_gib": 16.0,
        "gpu": "none", "gpu_driver": "none", "device_category": "usb_headset", "mic_model": "FIXTURE_SYNTHETIC_SOURCE",
        "acoustic_environment": "quiet", "background_noise_level": "unmeasured", "system_load": "idle",
        "background_load_id": "fixture_load_v1",
    },
    "configuration": {
        "requested_model": "small", "effective_model": "small", "requested_device": "cpu", "effective_device": "cpu",
        "requested_compute_type": "int8", "effective_compute_type": "int8_float32", "partials_enabled": True,
        "dictation_mode": "quick", "beam_size": 5, "language": "en",
        "runtime_settings_id": "fixture_runtime_v1",
    },
    "trial_metadata": {
        "trial_id": "trial_fixture_00", "corpus_id": "fixture_synthetic_v1", "warmup_policy": "isolate_first_run",
        "evidence_type": "synthetic", "speaker_stratum": "schema_fixture_synthetic", "content_domain": "general_english",
        "edge_case_type": None, "is_warmup": False, "repetition_index": 0, "total_repetitions": 5, "audio_duration_seconds": 3.0,
    },
    "stage_timings": {"timing_clock_domain": "monotonic_ms", "measurement_policy_id": "fixture_measurement_v1", **{tf: None for tf in TIMING_FIELDS}},
    "rates": {"real_time_factor": None, "processing_speed_ratio": None, "words_per_second": None},
    "resources": {rf: None for rf in ["server_peak_rss_mib", "server_settled_rss_mib", "app_peak_rss_mib", "cpu_process_percent", "gpu_vram_delta_mib"]},
    "evaluation": {
        "scoring_normalization": "standard", "output_empty": False, "expected_speech": True, "outcome": "success",
        "human_assessment": None, "reference_word_count": 10, "word_errors": 1, "wer": 0.1, "wer_fraction": "1/10 = 10.0%",
        "reference_char_count": 50, "char_errors": 2, "cer": 0.04, "cer_fraction": "2/50 = 4.0%", "critical_entity_errors": 0,
    },
}

def generate_fixture_demonstration_records() -> List[Dict[str, Any]]:
    records = []
    w = copy.deepcopy(BASE_FIXTURE_RECORD)
    w["run_id"] = "fixture_warmup_00"; w["trial_metadata"]["trial_id"] = "trial_fixture_warmup"; w["trial_metadata"]["is_warmup"] = True
    records.append(w)
    for i in range(4):
        m = copy.deepcopy(BASE_FIXTURE_RECORD)
        m["run_id"] = f"fixture_measured_{i:02d}"; m["trial_metadata"]["trial_id"] = f"trial_fixture_{i:02d}"
        m["trial_metadata"]["repetition_index"] = i; m["trial_metadata"]["total_repetitions"] = 4
        records.append(m)
    e = copy.deepcopy(BASE_FIXTURE_RECORD)
    e["run_id"] = "fixture_edge_silence"; e["trial_metadata"]["trial_id"] = "trial_fixture_edge_silence"
    e["trial_metadata"]["edge_case_type"] = "silence"; e["evaluation"]["output_empty"] = True
    e["evaluation"]["expected_speech"] = False; e["evaluation"]["reference_word_count"] = 0
    e["evaluation"]["word_errors"] = None; e["evaluation"]["wer"] = None; e["evaluation"]["wer_fraction"] = None
    e["evaluation"]["reference_char_count"] = 0; e["evaluation"]["char_errors"] = None
    e["evaluation"]["cer"] = None; e["evaluation"]["cer_fraction"] = None
    records.append(e)
    return records

def cmd_validate(args: argparse.Namespace) -> int:
    try: records = load_records_file(Path(args.input_file))
    except Exception:
        sys.stderr.write("Error loading records: failed to load input file\n"); return 1
    total_errors = sum(len(validate_record_dict(r)) for r in records)
    if total_errors > 0:
        for idx, r in enumerate(records, 1):
            for e in validate_record_dict(r): sys.stderr.write(f"Record {idx} error: {e}\n")
        return 1
    print(f"Validated {len(records)} record(s) successfully: all records conform to schema.")
    return 0

def cmd_score(args: argparse.Namespace) -> int:
    try:
        ref_path, hyp_path = ensure_safe_external_path(Path(args.reference_file)), ensure_safe_external_path(Path(args.hypothesis_file))
        ref_text, hyp_text = ref_path.read_text(encoding="utf-8-sig"), hyp_path.read_text(encoding="utf-8-sig")
    except (ValueError, OSError):
        sys.stderr.write("Error: score input unavailable or rejected\n"); return 1
    norm = not args.raw
    w_err, w_ref, wer, w_frac = compute_wer(ref_text, hyp_text, normalize=norm)
    c_err, c_ref, cer, c_frac = compute_cer(ref_text, hyp_text, normalize=norm)
    print(f"Levenshtein Offline Scoring Results:\n  Normalization identity: {'standard' if norm else 'raw'}\n  Reference word count: {w_ref}\n  Word errors: {w_err}\n  Word Error Rate (WER): {'unavailable' if wer is None else f'{wer:.1%}'} ({w_frac or 'unavailable'})\n  Reference character count: {c_ref}\n  Character errors: {c_err}\n  Character Error Rate (CER): {'unavailable' if cer is None else f'{cer:.1%}'} ({c_frac or 'unavailable'})")
    return 0

def cmd_aggregate(args: argparse.Namespace) -> int:
    try: records = load_records_file(Path(args.input_file))
    except Exception:
        sys.stderr.write("Error loading records: failed to load input file\n"); return 1
    if not records:
        sys.stderr.write("No records to aggregate.\n"); return 1
    for idx, r in enumerate(records, 1):
        if validate_record_dict(r):
            sys.stderr.write(f"Record {idx} failed schema validation; cannot aggregate.\n"); return 1
    if args.strict_single_stratum:
        try: check_pooling_compatibility(records)
        except IncompatiblePoolingError as exc:
            sys.stderr.write(f"Strict single-stratum check failed: {exc}\n"); return 1
    try: summaries = stratify_and_summarize(records)
    except IncompatiblePoolingError as exc:
        sys.stderr.write(f"Aggregation failed: {exc}\n"); return 1
    if args.format == "json": print(json.dumps([s.to_dict() for s in summaries], indent=2))
    else: print(format_summary_markdown(summaries))
    return 0

def cmd_baseline(args: argparse.Namespace) -> int:
    print("=" * 72 + "\nEve B4 Milestone Alpha Validation Baseline Status\n" + "=" * 72)
    print("Source baseline: 3146b3a3057ff7c55c35e6eeb63b98943f145e13 (not a B4 candidate artifact)")
    print("Physical evidence sample count: n = 0 (PENDING)")
    print("  Zero physical microphone trials or product latencies have been measured")
    print("  for B4. All physical gates remain pending")
    print("  until consented operator execution with candidate builds.\n")
    print("Frozen Baseline Documentation:\n  Refer to docs/architecture/eve-b4-validation-baseline.md\n" + "=" * 72)
    return 0

def cmd_demo(args: argparse.Namespace) -> int:
    print("Running Eve B4 validation schema fixture demonstration...")
    records = generate_fixture_demonstration_records()
    for idx, r in enumerate(records, 1):
        errs = validate_record_dict(r)
        if errs:
            sys.stderr.write(f"Validation failure in fixture record {idx}: {errs}\n"); return 1
    print(f"Generated and validated {len(records)} schema fixture records (all product n=0).\n")
    summaries = stratify_and_summarize(records)
    print(format_summary_markdown(summaries))
    print("Schema fixture demonstration completed successfully.")
    return 0

def cmd_template(args: argparse.Namespace) -> int:
    template = copy.deepcopy(BASE_FIXTURE_RECORD)
    for field in ("reference_word_count", "word_errors", "wer", "wer_fraction", "reference_char_count", "char_errors", "cer", "cer_fraction", "critical_entity_errors"):
        template["evaluation"][field] = None
    print(json.dumps(template, indent=2))
    return 0

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Eve B4 Offline Validation, Scoring, and Reporting Harness (Python stdlib)")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)
    p_val = subparsers.add_parser("validate", help="Validate JSON/NDJSON records against schema")
    p_val.add_argument("input_file", help="Path to JSON or NDJSON file")
    p_score = subparsers.add_parser("score", help="Compute WER and CER without echoing private text")
    p_score.add_argument("--reference-file", "-rf", required=True, help="Path to reference transcript")
    p_score.add_argument("--hypothesis-file", "-hf", required=True, help="Path to hypothesis transcript")
    p_score.add_argument("--raw", action="store_true", help="Score raw text")
    p_agg = subparsers.add_parser("aggregate", help="Compute stratified aggregate summary")
    p_agg.add_argument("input_file", help="Path to JSON or NDJSON validation records")
    p_agg.add_argument("--format", choices=["markdown", "json"], default="markdown", help="Output format")
    p_agg.add_argument("--strict-single-stratum", action="store_true", help="Enforce all records belong to single stratum")
    subparsers.add_parser("baseline", help="Print honest baseline status (n=0 physical evidence)")
    subparsers.add_parser("demo", help="Run deterministic schema fixture demonstration (product n=0)")
    subparsers.add_parser("template", help="Print discoverable fixture JSON template (all times null)")
    args = parser.parse_args(argv)
    handlers = {
        "validate": cmd_validate, "score": cmd_score, "aggregate": cmd_aggregate,
        "baseline": cmd_baseline, "demo": cmd_demo, "template": cmd_template,
    }
    return handlers[args.subcommand](args)

if __name__ == "__main__":
    sys.exit(main())
