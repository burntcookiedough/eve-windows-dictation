"""Explicit localhost replay and predeclared before/after regression comparisons.

Never records audio, launches a server, downloads models, or prints test speech.
Run using the existing Windows server development environment (websockets extra).
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
from urllib.parse import urlsplit
import uuid
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.accuracy_scoring import AccuracyAccumulator
from scripts.validation_harness import (
    BASE_FIXTURE_RECORD, compute_cer, compute_wer, ensure_safe_external_path,
    get_stratum_key, load_records_file, stratify_and_summarize, validate_record_dict,
)


def validate_url(url):
    """Allow only an explicitly selected local speech server, without credentials."""
    parsed = urlsplit(url)
    if (parsed.scheme != 'ws' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError('Replay requires a plain localhost WebSocket URL')
    return url


def load_manifest(path):
    """Read only an external test manifest and reject unmeasured fixture provenance."""
    path = ensure_safe_external_path(Path(path))
    manifest = json.loads(path.read_text(encoding='utf-8-sig'))
    if set(manifest) != {'record', 'clips'} or not manifest['clips']:
        raise ValueError('Invalid replay manifest')
    record = manifest['record']
    if validate_record_dict(record):
        raise ValueError('Manifest record violates the shared schema')
    if (record['build_info']['commit'] == '0' * 40
            or record['build_info']['artifact_sha256'] == '0' * 64
            or not record['build_info']['clean_tree']):
        raise ValueError('Verified exact-artifact provenance is required')
    if record['trial_metadata']['evidence_type'] != 'replay':
        raise ValueError('Replay must be labelled replay evidence')
    if record['trial_metadata']['warmup_policy'] != 'one_excluded_per_clip':
        raise ValueError('Replay warmup policy must be one_excluded_per_clip')
    clips = []
    corpus_hash = hashlib.sha256()
    for item in manifest['clips']:
        if set(item) != {'audio', 'reference', 'speaker_stratum', 'content_domain'}:
            raise ValueError('Invalid clip manifest')
        clip = dict(item)
        for field in ('audio', 'reference'):
            clip[field] = ensure_safe_external_path(path.parent / item[field])
        with wave.open(str(clip['audio']), 'rb') as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, 'NONE'):
                raise ValueError('Replay requires mono 16 kHz signed 16-bit PCM WAV')
            clip['duration'] = wav.getnframes() / 16000
            if not 0 < clip['duration'] <= 7200:
                raise ValueError('Invalid replay duration')
        # Validate each clip before any network connection or speech processing.
        candidate = copy.deepcopy(record)
        candidate['trial_metadata'].update(speaker_stratum=clip['speaker_stratum'],
            content_domain=clip['content_domain'], audio_duration_seconds=clip['duration'])
        if validate_record_dict(candidate):
            raise ValueError('Invalid clip metadata')
        for field in ('audio', 'reference'):
            digest = hashlib.sha256()
            with clip[field].open('rb') as source:
                while block := source.read(65536):
                    digest.update(block)
            corpus_hash.update(digest.digest())
        corpus_hash.update(json.dumps([clip['speaker_stratum'], clip['content_domain']]).encode())
        clips.append(clip)
    record['trial_metadata']['corpus_id'] = 'replay-sha256-' + corpus_hash.hexdigest()
    return record, clips


async def replay_trial(url, clip, *, timeout=300, connect=None):
    """Stream one declared WAV at real time and measure receipt using one observer clock."""
    if connect is None:
        from websockets.asyncio.client import connect
    state = {'first_partial_ms': None, 'stop_to_final_text_ms': None,
             'last_audio_ms': None, 'server_perf': None, 'text': None,
             'outcome': 'unexpected_failure'}
    trace_id = str(uuid.uuid4())
    async with connect(validate_url(url), max_size=4 * 1024 * 1024) as ws:
        # Long timeout prevents an auto-stop experiment from changing the replay boundary.
        # This runner measures explicit-stop behavior only; test auto-stop separately.
        await ws.send(json.dumps({'frame': 'control', 'type': 'start',
                                  'silence_timeout': 7200, 'trace_id': trace_id}))
        while True:
            frame = json.loads(await asyncio.wait_for(ws.recv(), timeout))
            if frame.get('frame') == 'control' and frame.get('type') == 'ready':
                break
            if frame.get('type') in {'error', 'closing'}:
                return state
        stream_started = time.perf_counter()
        stop_requested = None
        last_sent = None
        final_ready = asyncio.Event()

        async def receive():
            while True:
                frame = json.loads(await ws.recv())
                now = time.perf_counter()
                if frame.get('frame') == 'text' and frame.get('type') == 'partial':
                    if state['first_partial_ms'] is None:
                        state['first_partial_ms'] = (now - stream_started) * 1000
                elif frame.get('frame') == 'text' and frame.get('type') == 'final':
                    # A final before explicit stop is a failed comparable replay trial.
                    if stop_requested is not None:
                        state['stop_to_final_text_ms'] = (now - stop_requested) * 1000
                        state['text'] = frame.get('text', '')
                        state['outcome'] = 'success'
                        perf = frame.get('perf')
                        if isinstance(perf, dict) and perf.get('session_id') == trace_id:
                            state['server_perf'] = perf
                    final_ready.set()
                    return
                elif frame.get('type') in {'error', 'closing'}:
                    final_ready.set()
                    return

        receiver = asyncio.create_task(receive())
        try:
            with wave.open(str(clip['audio']), 'rb') as wav:
                sequence = 0
                samples_sent = 0
                while pcm := wav.readframes(3200):
                    if final_ready.is_set():
                        break
                    await ws.send(struct.pack('>HHB', sequence % 65536, len(pcm) // 2, 0) + pcm)
                    last_sent = time.perf_counter()
                    samples_sent += len(pcm) // 2
                    sequence += 1
                    await asyncio.sleep(max(0, stream_started + samples_sent / 16000 - time.perf_counter()))
            if not final_ready.is_set():
                stop_requested = time.perf_counter()
                state['last_audio_ms'] = ((stop_requested - last_sent) * 1000 if last_sent is not None else None)
                await ws.send(json.dumps({'frame': 'control', 'type': 'stop'}))
                await asyncio.wait_for(final_ready.wait(), timeout)
            await receiver
        finally:
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
    return state


def paths_collide(p1: Path, p2: Path) -> bool:
    """Return True if two paths resolve to the same filesystem location or alias."""
    try:
        r1 = p1.resolve()
        r2 = p2.resolve()
    except Exception:
        r1 = p1.absolute()
        r2 = p2.absolute()
    if r1 == r2:
        return True
    try:
        return r1.samefile(r2)
    except OSError:
        pass
    if os.name == 'nt':
        return os.path.normcase(str(r1)) == os.path.normcase(str(r2))
    return False


def make_record(template, clip, observation, *, run_id, trial_id, repetition, repetitions, warmup, raw):
    """Translate observed replay durations into the shared schema without inventing stages."""
    record = copy.deepcopy(template)
    record['run_id'] = run_id
    record['timestamp'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    record['trial_metadata'].update(trial_id=trial_id, evidence_type='replay',
        speaker_stratum=clip['speaker_stratum'], content_domain=clip['content_domain'],
        edge_case_type=None, is_warmup=warmup, repetition_index=repetition,
        total_repetitions=repetitions, audio_duration_seconds=clip['duration'])
    timings = record['stage_timings']
    for key in timings:
        if key.endswith('_ms'):
            timings[key] = None
    timings.update(timing_clock_domain='replay_observer_perf_counter',
        measurement_policy_id='b4_replay_explicit_stop_v1',
        first_partial_ms=observation['first_partial_ms'],
        last_audio_ms=observation['last_audio_ms'],
        stop_to_final_text_ms=observation['stop_to_final_text_ms'])
    # Server durations remain in their own domain, never subtracted from observer timestamps.
    perf = observation['server_perf'] or {}
    for source, target in (('lock_wait_ms', 'queue_wait_ms'), ('model_inference_ms', 'model_inference_ms')):
        value = perf.get(source)
        if type(value) in (int, float) and math.isfinite(value) and value >= 0:
            timings[target] = value
    record['resources'] = {key: None for key in record['resources']}
    record['rates'] = {key: None for key in record['rates']}
    evaluation = record['evaluation']
    evaluation.update(output_empty=observation['text'] is not None and not observation['text'].strip(), expected_speech=True,
        outcome=observation['outcome'], scoring_normalization='raw' if raw else 'standard',
        human_assessment=None, critical_entity_errors=None)
    for key in ('reference_word_count', 'word_errors', 'wer', 'wer_fraction',
                'reference_char_count', 'char_errors', 'cer', 'cer_fraction'):
        evaluation[key] = None
    if observation['text'] is not None:
        reference = clip['reference'].read_text(encoding='utf-8-sig')
        errors, count, rate, fraction = compute_wer(reference, observation['text'], normalize=not raw)
        evaluation.update(word_errors=errors, reference_word_count=count, wer=rate, wer_fraction=fraction)
        errors, count, rate, fraction = compute_cer(reference, observation['text'], normalize=not raw)
        evaluation.update(char_errors=errors, reference_char_count=count, cer=rate, cer_fraction=fraction)
    if validate_record_dict(record):
        raise ValueError('Observed record violates shared schema')
    return record


async def run_replay(args):
    """Run only the explicitly supplied external test corpus and write safe trial records."""
    template, clips = load_manifest(args.manifest)
    manifest_path = ensure_safe_external_path(Path(args.manifest))
    output = ensure_safe_external_path(Path(args.output))
    accuracy_output = ensure_safe_external_path(Path(args.accuracy_output)) if getattr(args, 'accuracy_output', None) else None

    # Fail BEFORE network/output mutation for existing report or collision with primary log/manifest/reference/audio.
    protected_paths = [("manifest", manifest_path)]
    for idx, clip in enumerate(clips):
        protected_paths.append((f"clip {idx} audio", clip['audio']))
        protected_paths.append((f"clip {idx} reference", clip['reference']))

    for name, p in protected_paths:
        if paths_collide(output, p):
            raise ValueError(f"Primary output path collides with {name}: {output}")

    if output.exists():
        raise FileExistsError(f"Primary output path already exists: {output}")

    if accuracy_output is not None:
        if paths_collide(accuracy_output, output):
            raise ValueError(f"Accuracy output path collides with primary output: {accuracy_output}")
        for name, p in protected_paths:
            if paths_collide(accuracy_output, p):
                raise ValueError(f"Accuracy output path collides with {name}: {accuracy_output}")
        if accuracy_output.exists():
            raise FileExistsError(f"Accuracy output path already exists: {accuracy_output}")

    validate_url(args.url)
    run_id = str(uuid.uuid4())
    accumulator = AccuracyAccumulator(template) if accuracy_output is not None else None

    # Reserve/open new sidecar exclusively before first replay; never overwrite existing evidence.
    sidecar_sink = None
    if accuracy_output is not None:
        sidecar_sink = accuracy_output.open('x', encoding='utf-8')
        sidecar_sink.write('{"report_status":"incomplete"}')
        sidecar_sink.flush()

    try:
        with output.open('x', encoding='utf-8') as sink:
            for clip_index, clip in enumerate(clips):
                for repetition in range(args.repetitions + 1):
                    observation = {'first_partial_ms': None, 'stop_to_final_text_ms': None,
                        'last_audio_ms': None, 'server_perf': None, 'text': None, 'outcome': 'unexpected_failure'}
                    try:
                        observation = await replay_trial(args.url, clip, timeout=args.timeout)
                    except Exception:
                        # Failed trials stay in the denominator; never emit remote error text.
                        pass
                    is_warmup = repetition == 0
                    record = make_record(template, clip, observation, run_id=run_id,
                        trial_id=f'clip-{clip_index}-repeat-{repetition}', repetition=repetition,
                        repetitions=args.repetitions + 1, warmup=is_warmup, raw=args.raw)
                    sink.write(json.dumps(record) + '\n')
                    sink.flush()
                    if accumulator is not None:
                        accumulator.record_trial(record, clip=clip, observation=observation)
    except BaseException:
        # Keep reserved evidence explicitly incomplete and close it on cancellation.
        if sidecar_sink is not None:
            sidecar_sink.close()
        raise

    # Primary trial records must survive sidecar error.
    if accumulator is not None and sidecar_sink is not None:
        temporary_path = None
        try:
            report_dict = accumulator.to_dict(run_id=run_id)
            serialized = json.dumps(report_dict, indent=2)
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                    dir=accuracy_output.parent, prefix=f'.{accuracy_output.name}.',
                    suffix='.tmp', delete=False) as candidate:
                temporary_path = Path(candidate.name)
                candidate.write(serialized)
                candidate.flush()
                os.fsync(candidate.fileno())
            sidecar_sink.close()
            sidecar_sink = None
            os.replace(temporary_path, accuracy_output)
        finally:
            if sidecar_sink is not None:
                sidecar_sink.close()
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    print('Replay records saved externally; no speech text emitted. Physical and insertion evidence: unavailable.')


def compare_records(before, after, thresholds):
    """Compare like-for-like strata using explicit predeclared regression limits."""
    def indexed(records):
        grouped = {}
        seen = set()
        for record in records:
            identity = (record['run_id'], record['trial_metadata']['trial_id'], record['evaluation']['scoring_normalization'])
            if identity in seen:
                raise ValueError('Duplicate trial identities cannot inflate sample counts')
            seen.add(identity)
        for summary in stratify_and_summarize(records):
            key = summary.key.to_display_dict()
            for field in ('commit', 'artifact_name', 'artifact_sha256'):
                key.pop(field)
            identity = json.dumps(key, sort_keys=True)
            if identity in grouped:
                raise ValueError('Multiple artifacts cannot be combined in a comparison side')
            grouped[identity] = summary
        return grouped
    left, right = indexed(before), indexed(after)
    if left.keys() != right.keys() or not left:
        raise ValueError('Before and after strata must match apart from source/artifact identity')
    results = []
    for identity in left:
        old, new = left[identity], right[identity]
        if old.measured_trials != new.measured_trials:
            raise ValueError('Comparison requires identical measured trial allocation')
        checks = {}
        for percentile in ('p50_ms', 'p95_ms'):
            old_stage, new_stage = old.timings['stop_to_final_text_ms'], new.timings['stop_to_final_text_ms']
            baseline, candidate = getattr(old_stage, percentile), getattr(new_stage, percentile)
            sufficient = min(old_stage.observed_count, new_stage.observed_count) >= thresholds['minimum_samples']
            checks[percentile] = ('unavailable' if not sufficient or baseline is None or candidate is None else
                'pass' if candidate <= baseline + max(thresholds['latency_absolute_ms'], baseline * thresholds['latency_relative']) else 'fail')
        checks['wer'] = ('unavailable' if min(old.scored_word_trials_count, new.scored_word_trials_count) < thresholds['minimum_samples'] or old.pooled_wer is None or new.pooled_wer is None else
            'pass' if new.pooled_wer <= old.pooled_wer + thresholds['wer_absolute'] else 'fail')
        checks['failure_rate'] = ('unavailable' if old.unexpected_failure_rate is None or new.unexpected_failure_rate is None else
            'pass' if new.unexpected_failure_rate <= old.unexpected_failure_rate else 'fail')
        checks['empty_rate'] = ('unavailable' if old.empty_on_expected_speech_rate is None or new.empty_on_expected_speech_rate is None else
            'pass' if new.empty_on_expected_speech_rate <= old.empty_on_expected_speech_rate else 'fail')
        checks['critical_entities'] = ('unavailable' if old.critical_entity_errors_count is None or new.critical_entity_errors_count is None else
            'pass' if new.critical_entity_errors_count <= old.critical_entity_errors_count else 'fail')
        # Replay alone cannot approve resource, auto-stop, partial quality, or actual insertion changes.
        for gate in ('cpu_ram', 'partial_quality', 'auto_stop', 'actual_insertion'):
            checks[gate] = 'manual_required'
        results.append({'stratum': json.loads(identity), 'before_n': old.measured_trials,
            'after_n': new.measured_trials, 'checks': checks, 'optimization_accepted': False})
    return results


def main(argv=None):
    """Dispatch explicit replay or offline comparison; default execution is read-only help."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    replay = sub.add_parser('replay')
    replay.add_argument('--manifest', required=True)
    replay.add_argument('--output', required=True)
    replay.add_argument('--url', default='ws://127.0.0.1:51717/transcribe')
    replay.add_argument('--repetitions', type=int, default=2)
    replay.add_argument('--timeout', type=float, default=300)
    replay.add_argument('--raw', action='store_true')
    replay.add_argument('--accuracy-output', default=None, help='Optional path for safe aggregate accuracy report')
    compare = sub.add_parser('compare')
    compare.add_argument('--before', required=True)
    compare.add_argument('--after', required=True)
    compare.add_argument('--thresholds', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'replay':
            if not 1 <= args.repetitions <= 100 or not math.isfinite(args.timeout) or args.timeout <= 0:
                raise ValueError('Invalid replay bounds')
            asyncio.run(run_replay(args))
        else:
            thresholds = json.loads(ensure_safe_external_path(Path(args.thresholds)).read_text(encoding='utf-8-sig'))
            expected = {'minimum_samples', 'latency_absolute_ms', 'latency_relative', 'wer_absolute'}
            if set(thresholds) != expected or any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in thresholds.values()) or type(thresholds['minimum_samples']) is not int or thresholds['minimum_samples'] < 20:
                raise ValueError('Invalid predeclared thresholds')
            result = compare_records(load_records_file(Path(args.before)), load_records_file(Path(args.after)), thresholds)
            print(json.dumps(result, indent=2))
            if any('fail' in row['checks'].values() for row in result):
                return 1
        return 0
    except Exception:
        print('Benchmark rejected or unavailable; inspect only the isolated test setup. No input content or paths emitted.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
