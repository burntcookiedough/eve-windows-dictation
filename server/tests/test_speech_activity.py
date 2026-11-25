"""Coverage for streaming Silero state and the bounded fallback clock."""

import threading
from types import SimpleNamespace

import numpy as np
import pytest

import audio.speech_activity as activity_module
from audio.speech_activity import SpeechActivity, WINDOW_SAMPLES, _SileroStream


async def test_streaming_scores_match_bundled_batch_and_isolate_state(monkeypatch):
    from faster_whisper.vad import get_vad_model

    audio = np.random.default_rng(27).normal(0, 0.15, 11 * WINDOW_SAMPLES).astype(np.float32)
    frames = audio.reshape(-1, WINDOW_SAMPLES)
    # The batch wrapper zeros the final context via a view into its input.
    # Give it a disposable last window to keep every tested sample intact.
    expected = get_vad_model()(np.pad(audio, (0, WINDOW_SAMPLES))).ravel()[:-1]
    monkeypatch.setattr(activity_module, "_silero_session", None)
    await activity_module.warm_silero()
    first = _SileroStream()
    second = _SileroStream()

    leading = first.probabilities(frames[:2])
    uninterrupted = second.probabilities(frames)
    remaining = np.concatenate([first.probabilities(frame) for frame in np.split(frames[2:], [4])])

    np.testing.assert_allclose(uninterrupted, expected, atol=1e-6)
    np.testing.assert_allclose(np.concatenate((leading, remaining)), expected, atol=1e-6)


def test_arbitrary_pcm_partitions_carry_remainder_and_keep_monotonic_samples(monkeypatch):
    observed = []

    def probability(frames):
        observed.extend(frames.copy())
        return frames[:, 0]

    monkeypatch.setattr(activity_module, "_SileroStream", lambda: SimpleNamespace(probabilities=probability))
    activity = SpeechActivity()
    # The second frame continues quiet speech through hysteresis. The last
    # frame resumes speech after a complete silent window.
    audio = np.repeat(np.array([20000, 13000, 0, 21000], dtype=np.int16), WINDOW_SAMPLES)
    positions = [200, 810, 1024, 1600, len(audio)]
    speech_ends = []
    cursor = 0
    for end in positions:
        activity.append(audio[cursor:end])
        assert activity.processed_samples == end // WINDOW_SAMPLES * WINDOW_SAMPLES
        speech_ends.append(activity.last_speech_sample)
        cursor = end

    assert speech_ends == [None, 512, 1024, 1024, 2048]
    np.testing.assert_array_equal(np.concatenate(observed), audio.astype(np.float32) / 32768)


async def test_failed_startup_warm_runs_off_loop_and_audio_uses_energy_without_retry(monkeypatch):
    load_threads = []
    loop_thread = threading.get_ident()

    def broken_model():
        load_threads.append(threading.get_ident())
        raise ImportError("missing runtime")

    monkeypatch.setattr(activity_module, "_silero_session", None)
    monkeypatch.setattr(activity_module, "_load_silero_session", broken_model)
    await activity_module.warm_silero()
    activity = SpeechActivity()
    activity.append(np.zeros(WINDOW_SAMPLES, dtype=np.int16))
    activity.append(np.full(WINDOW_SAMPLES, 120, dtype=np.int16))
    activity.append(np.full(WINDOW_SAMPLES, 10, dtype=np.int16))

    assert len(load_threads) == 1 and load_threads[0] != loop_thread
    assert activity.last_speech_sample == 2 * WINDOW_SAMPLES
    assert activity.processed_samples == 3 * WINDOW_SAMPLES
    assert activity.silero_pause_start is None


def test_mid_session_failure_preserves_clock_and_recovers_current_frame(monkeypatch):
    calls = 0

    def probabilities(frames):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("model inference failed")
        return np.full(len(frames), 0.7)

    monkeypatch.setattr(activity_module, "_SileroStream", lambda: SimpleNamespace(probabilities=probabilities))
    activity = SpeechActivity()
    activity.append(np.zeros(WINDOW_SAMPLES + 17, dtype=np.int16))
    assert activity.last_speech_sample == WINDOW_SAMPLES

    activity.append(np.full(WINDOW_SAMPLES - 17, 1000, dtype=np.int16))
    assert activity.last_speech_sample == 2 * WINDOW_SAMPLES
    activity.append(np.zeros(WINDOW_SAMPLES, dtype=np.int16))
    assert activity.last_speech_sample == 2 * WINDOW_SAMPLES
    activity.append(np.full(WINDOW_SAMPLES, 1000, dtype=np.int16))
    assert activity.last_speech_sample == activity.processed_samples == 4 * WINDOW_SAMPLES
    assert activity.silero_pause_start is None
    assert calls == 2


def test_fallback_keeps_detecting_soft_speech_below_fixed_threshold(monkeypatch):
    monkeypatch.setattr(activity_module, "_silero_session", None)
    activity = SpeechActivity()
    room_tone = np.full(8 * WINDOW_SAMPLES, 36, dtype=np.int16)
    # Syllables and short gaps continue for eight seconds at less than 0.01 RMS.
    syllables = np.repeat(np.tile([36, 115, 155, 140, 42], 50), WINDOW_SAMPLES).astype(np.int16)
    activity.append(room_tone)
    for delivery in np.split(syllables, 10):
        activity.append(delivery)
        assert activity.last_speech_sample == activity.processed_samples - WINDOW_SAMPLES

    final_speech = activity.last_speech_sample
    activity.append(room_tone)
    assert activity.last_speech_sample == final_speech


@pytest.mark.parametrize("voiced", [[115, 155] + [140] * 7, [140] * 9])
def test_fallback_keeps_timing_repeated_soft_syllables_for_ten_seconds(monkeypatch, voiced):
    monkeypatch.setattr(activity_module, "_silero_session", None)
    activity = SpeechActivity()
    activity.append(np.full(8 * WINDOW_SAMPLES, 36, dtype=np.int16))
    syllable = np.repeat(np.array([36, *voiced], dtype=np.int16), WINDOW_SAMPLES)

    # Each syllable has only one quiet window. A percentile of every window
    # would eventually use speech to raise the threshold above the syllables.
    for _ in range(35):
        activity.append(syllable)
        assert activity.last_speech_sample == activity.processed_samples


def test_fallback_recalibrates_to_a_fan_above_fixed_threshold(monkeypatch):
    monkeypatch.setattr(activity_module, "_silero_session", None)
    # A fan fluctuates slightly and remains louder than 0.01 RMS.
    fan = np.repeat(np.tile([490, 515, 510, 495], 20), WINDOW_SAMPLES).astype(np.int16)
    warm_start = SpeechActivity()
    for delivery in np.split(fan, 4):
        warm_start.append(delivery)
    assert warm_start.last_speech_sample is None

    switched_on = SpeechActivity()
    switched_on.append(np.full(64 * WINDOW_SAMPLES, 30, dtype=np.int16))
    for delivery in np.split(fan, 4):
        switched_on.append(delivery)
    settling_speech = switched_on.last_speech_sample
    assert settling_speech is not None
    for _ in range(3):
        for delivery in np.split(fan, 4):
            switched_on.append(delivery)
    assert switched_on.processed_samples - settling_speech > 5 * 16000
    assert switched_on.last_speech_sample == settling_speech
