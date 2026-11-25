"""Coverage for streaming Silero state and the bounded fallback clock."""

from types import SimpleNamespace

import numpy as np

import audio.speech_activity as activity_module
from audio.speech_activity import SpeechActivity, WINDOW_SAMPLES, _SileroStream


def test_streaming_scores_match_bundled_batch_and_isolate_state():
    from faster_whisper.vad import get_vad_model

    audio = np.random.default_rng(27).normal(0, 0.15, 11 * WINDOW_SAMPLES).astype(np.float32)
    frames = audio.reshape(-1, WINDOW_SAMPLES)
    # The batch wrapper zeros the final context via a view into its input.
    # Give it a disposable last window to keep every tested sample intact.
    expected = get_vad_model()(np.pad(audio, (0, WINDOW_SAMPLES))).ravel()[:-1]
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


def test_failed_model_load_uses_energy_once_without_qualifying_as_silero_pause(monkeypatch):
    attempts = 0

    def broken_model():
        nonlocal attempts
        attempts += 1
        raise ImportError("missing runtime")

    monkeypatch.setattr(activity_module, "_SileroStream", broken_model)
    activity = SpeechActivity()
    activity.append(np.full(WINDOW_SAMPLES, 1000, dtype=np.int16))
    activity.append(np.full(WINDOW_SAMPLES, 200, dtype=np.int16))

    assert attempts == 1
    assert activity.last_speech_sample == WINDOW_SAMPLES
    assert activity.processed_samples == 2 * WINDOW_SAMPLES
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
