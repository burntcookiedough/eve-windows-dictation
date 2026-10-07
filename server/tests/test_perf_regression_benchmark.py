"""Exercise the replay observer against an isolated local protocol peer, not a speech model."""
import copy
import json
from pathlib import Path
import wave
import sys

import pytest
from websockets.asyncio.server import serve

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.perf_regression_benchmark import (
    compare_records, load_manifest, make_record, replay_trial, validate_url,
)
from scripts.validation_harness import BASE_FIXTURE_RECORD, validate_record_dict


def test_replay_rejects_remote_servers_and_fixture_provenance(tmp_path):
    """Explicit external test inputs cannot target remote services or pretend fixtures are artifacts."""
    for url in ('ws://example.com/transcribe', 'wss://localhost/transcribe',
                'ws://user:password@localhost/transcribe', 'ws://localhost/transcribe?secret=x'):
        with pytest.raises(ValueError):
            validate_url(url)
    manifest = {'record': copy.deepcopy(BASE_FIXTURE_RECORD), 'clips': [{}]}
    path = tmp_path / 'manifest.json'
    path.write_text(json.dumps(manifest), encoding='utf-8')
    with pytest.raises(ValueError, match='provenance'):
        load_manifest(path)


@pytest.mark.asyncio
async def test_replay_observes_real_protocol_receipt_and_leaves_outputs_unavailable(tmp_path):
    """Stream synthetic PCM through a real socket and observe separate first-partial/final boundaries."""
    audio = tmp_path / 'synthetic.wav'
    with wave.open(str(audio), 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        wav.writeframes(b'\0\0' * 1600)
    reference = tmp_path / 'reference.txt'
    reference.write_text('safe test', encoding='utf-8')
    seen = {}

    async def peer(ws):
        start = json.loads(await ws.recv())
        seen['start'] = start
        await ws.send(json.dumps({'frame': 'control', 'type': 'ready'}))
        audio_frame = await ws.recv()
        from audio.parser import parse_audio_frame
        seen['samples'] = parse_audio_frame(audio_frame).sample_count
        await ws.send(json.dumps({'frame': 'text', 'type': 'partial', 'text': 'safe'}))
        stop = json.loads(await ws.recv())
        assert stop['type'] == 'stop'
        await ws.send(json.dumps({'frame': 'text', 'type': 'final', 'text': 'safe test',
            'perf': {'session_id': start['trace_id'], 'lock_wait_ms': 1.25,
                     'model_inference_ms': 2.5}}))

    clip = {'audio': audio, 'reference': reference, 'duration': 0.1,
            'speaker_stratum': 'synthetic_peer', 'content_domain': 'general_english'}
    async with serve(peer, '127.0.0.1', 0) as server:
        port = server.sockets[0].getsockname()[1]
        observation = await replay_trial(f'ws://127.0.0.1:{port}/transcribe', clip)
    assert seen['samples'] == 1600
    assert observation['outcome'] == 'success'
    assert observation['first_partial_ms'] >= 0
    assert observation['stop_to_final_text_ms'] >= 0
    record = make_record(BASE_FIXTURE_RECORD, clip, observation, run_id='synthetic-test',
        trial_id='synthetic-01', repetition=1, repetitions=2, warmup=False, raw=True)
    assert validate_record_dict(record) == []
    assert record['trial_metadata']['evidence_type'] == 'replay'
    assert record['stage_timings']['model_inference_ms'] == 2.5
    for stage in ('actual_insertion_ms', 'clipboard_write_ms', 'final_to_history_ms', 'final_to_display_ms'):
        assert record['stage_timings'][stage] is None
    assert record['evaluation']['wer'] == 0
    assert all(value is None for value in record['resources'].values())


def test_comparison_does_not_accept_missing_evidence_or_mixed_settings():
    """Before/after comparisons enforce matching strata and do not approve optimizations from replay alone."""
    before = copy.deepcopy(BASE_FIXTURE_RECORD)
    after = copy.deepcopy(before)
    after['build_info']['commit'] = '1' * 40
    thresholds = {'minimum_samples': 20, 'latency_absolute_ms': 200,
                  'latency_relative': 0.10, 'wer_absolute': 0.01}
    result = compare_records([before], [after], thresholds)[0]
    assert result['checks']['p95_ms'] == 'unavailable'
    assert result['checks']['actual_insertion'] == 'manual_required'
    assert result['optimization_accepted'] is False
    after['configuration']['beam_size'] += 1
    with pytest.raises(ValueError, match='strata'):
        compare_records([before], [after], thresholds)
    with pytest.raises(ValueError, match='Duplicate'):
        compare_records([before, before], [after, after], thresholds)


def test_manifest_fingerprints_exact_corpus_and_respects_external_paths(tmp_path):
    """Changed replay audio or references change the grouping identity before measurement."""
    audio = tmp_path / 'script.wav'
    with wave.open(str(audio), 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        wav.writeframes(b'\0\0' * 1600)
    reference = tmp_path / 'reference.txt'
    reference.write_text('safe scripted speech', encoding='utf-8')
    record = copy.deepcopy(BASE_FIXTURE_RECORD)
    record['build_info'].update(commit='1' * 40, artifact_sha256='2' * 64)
    record['trial_metadata'].update(evidence_type='replay', warmup_policy='one_excluded_per_clip')
    manifest = {'record': record, 'clips': [{'audio': 'script.wav', 'reference': 'reference.txt',
        'speaker_stratum': 'synthetic_peer', 'content_domain': 'general_english'}]}
    path = tmp_path / 'manifest.json'
    path.write_text(json.dumps(manifest), encoding='utf-8-sig')
    before, clips = load_manifest(path)
    assert clips[0]['duration'] == 0.1
    reference.write_text('changed safe script', encoding='utf-8')
    after, _ = load_manifest(path)
    assert before['trial_metadata']['corpus_id'] != after['trial_metadata']['corpus_id']


def test_predeclared_guardrails_reject_slower_and_less_accurate_candidate():
    """A candidate cannot trade latency or quality regressions for an optimization claim."""
    before, after = [], []
    for index in range(20):
        old = copy.deepcopy(BASE_FIXTURE_RECORD)
        old['trial_metadata'].update(trial_id=f'trial-{index}', repetition_index=index, total_repetitions=20)
        old['stage_timings']['stop_to_final_text_ms'] = 500
        new = copy.deepcopy(old)
        new['build_info']['commit'] = '1' * 40
        new['stage_timings']['stop_to_final_text_ms'] = 800
        new['evaluation'].update(word_errors=2, wer=0.2, wer_fraction='2/10 = 20.0%')
        before.append(old)
        after.append(new)
    thresholds = {'minimum_samples': 20, 'latency_absolute_ms': 200,
                  'latency_relative': 0.10, 'wer_absolute': 0.01}
    checks = compare_records(before, after, thresholds)[0]['checks']
    assert checks['p50_ms'] == checks['p95_ms'] == checks['wer'] == 'fail'
    assert checks['cpu_ram'] == checks['actual_insertion'] == 'manual_required'
