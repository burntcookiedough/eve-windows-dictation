"""Incremental commit: seal recorded audio while the user is still talking.

Sealed audio is decoded once and its text becomes committed. The final
decodes only the uncommitted tail. The Lab can reuse a settled draft.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

from audio.buffer import AudioBuffer
from audio.speech_activity import SpeechActivity
from protocol.constants import AUDIO_SAMPLE_RATE
from transcription.long_dictation import AudioChunk, find_quiet_boundary, stitch_text, text_for_chunk
from transcription.types import TranscribeResult

FRAME_SAMPLES = AUDIO_SAMPLE_RATE // 50  # 20 ms energy frames
# A pause must last this long before it may hold a seal; stop closures and
# inter-word gaps inside one phrase are much shorter.
MIN_SEAL_SILENCE_S = 0.4
QUIET_NOISE_RATIO = 3.0
# Reusing a decode needs this much model-confirmed non-speech at its end.
SETTLED_GUARD_S = 0.3
# That stretch must be steady noise (p95 within 6 dB of its median), and new
# audio may be at most 6 dB above that median. A click, breath or soft speech
# in either fails the check, so the caller decodes again.
SETTLED_NOISE_RATIO = 2.0
SETTLED_ABS_FLOOR = 1e-4
# Never let one decode stand in for more than this much later audio: speech at
# room-noise level (a whisper) can pass the energy check, so bound what it hides.
SETTLED_MAX_NEW_S = 3.0
FORCE_SEAL_SEARCH_S = 1.5


@dataclass(frozen=True, slots=True)
class Decode:
    """One completed decode and the absolute buffer range it covered."""

    chunk: AudioChunk
    result: TranscribeResult


@dataclass(slots=True)
class CommittedTranscript:
    """Text that is final while recording continues."""

    end_sample: int = 0
    overlap_samples: int = 0
    texts: list[str] = field(default_factory=list)
    previous: Decode | None = None
    weighted_confidence: float = 0.0
    total_weight: float = 0.0
    last_speech_end: float | None = None

    @property
    def text(self) -> str:
        return stitch_text(self.texts)

    def tail_chunk(self, total_samples: int) -> AudioChunk:
        """The uncommitted range, with overlap only after a forced seal."""
        start = max(0, self.end_sample - self.overlap_samples)
        return AudioChunk(1, 1, start, total_samples, self.end_sample, total_samples)

    def text_for(self, decode: Decode) -> str:
        previous = (self.previous.chunk, self.previous.result) if self.previous else None
        return text_for_chunk(decode.result, decode.chunk, previous)

    def append(self, decode: Decode) -> None:
        chunk, result = decode.chunk, decode.result
        self.texts.append(self.text_for(decode))
        weight = max(0.001, chunk.logical_duration_s)
        self.weighted_confidence += result.confidence * weight
        self.total_weight += weight
        if result.last_speech_end is not None:
            absolute = chunk.start_s + result.last_speech_end
            self.last_speech_end = max(self.last_speech_end or 0.0, absolute)
        self.previous = decode
        self.end_sample = chunk.logical_end_sample
        self.overlap_samples = 0

    def copy(self) -> CommittedTranscript:
        return replace(self, texts=list(self.texts))

    def to_result(self) -> TranscribeResult:
        confidence = self.weighted_confidence / self.total_weight if self.total_weight > 0 else 0.0
        return TranscribeResult(
            text=self.text,
            confidence=min(1.0, max(0.0, confidence)),
            last_speech_end=self.last_speech_end,
        )


def frame_rms(
    buffer: AudioBuffer, start_sample: int, end_sample: int, *, include_partial: bool = False,
) -> np.ndarray:
    """RMS of consecutive 20 ms frames in ``[start_sample, end_sample)``.

    ``include_partial`` includes any leftover samples as one more frame.
    """
    audio = buffer.get_audio_range_float32(start_sample, end_sample)
    frames = len(audio) // FRAME_SAMPLES
    if frames == 0:
        if len(audio) == 0:
            return np.zeros(0, dtype=np.float64)
        return np.array([np.sqrt(np.mean(np.square(audio, dtype=np.float64)))])
    shaped = audio[: frames * FRAME_SAMPLES].reshape(frames, FRAME_SAMPLES)
    rms = np.sqrt(np.mean(np.square(shaped, dtype=np.float64), axis=1))
    leftover = audio[frames * FRAME_SAMPLES:]
    if include_partial and len(leftover):
        rms = np.append(rms, np.sqrt(np.mean(np.square(leftover, dtype=np.float64))))
    return rms


def plan_seal(
    buffer: AudioBuffer,
    speech_activity: SpeechActivity,
    *,
    committed_end: int,
    overlap_samples: int = 0,
    total_samples: int,
    seal_after_s: float,
    chunk_s: float,
    overlap_s: float,
) -> tuple[AudioChunk, int] | None:
    """Return the next sealable chunk and the overlap the following tail needs.

    Seals during a confirmed pause between ``seal_after_s`` and ``chunk_s``
    past the committed end, cutting inside silence with no overlap. Without
    such a pause, force-seals near ``chunk_s`` at the quietest point and keeps
    ``overlap_s`` so the next decode can be stitched with ``text_for_chunk``.
    ``overlap_samples`` is the overlap a previous forced seal left pending; the
    sealed chunk re-hears it so a word cut at that boundary is not lost.
    """
    rate = AUDIO_SAMPLE_RATE
    earliest = committed_end + int(seal_after_s * rate)
    latest = committed_end + int(chunk_s * rate)
    if total_samples <= earliest:
        return None

    pause_start = speech_activity.silero_pause_start
    pause_end = min(speech_activity.processed_samples, total_samples)
    silence_samples = int(MIN_SEAL_SILENCE_S * rate)
    guard_samples = silence_samples // 2
    noise_floor = speech_activity.pause_noise_floor
    boundary = None
    if noise_floor is not None and pause_start is not None and pause_start > committed_end:
        if pause_end - pause_start >= silence_samples:
            midpoint = min(latest, (pause_start + pause_end) // 2)
            if midpoint >= max(earliest, pause_start + guard_samples):
                rms = frame_rms(buffer, midpoint - guard_samples, midpoint + guard_samples)
                limit = QUIET_NOISE_RATIO * max(noise_floor, SETTLED_ABS_FLOOR)
                if len(rms) and float(rms.max()) <= limit:
                    boundary = midpoint

    overlap = 0
    if boundary is None:
        if total_samples < latest + int(FORCE_SEAL_SEARCH_S * rate):
            return None
        boundary = find_quiet_boundary(
            buffer, latest, search_s=FORCE_SEAL_SEARCH_S, limit=total_samples,
        )
        boundary = max(committed_end + rate, boundary)
        overlap = max(0, int(overlap_s * rate))
    start = max(0, committed_end - overlap_samples)
    # The next tail may only re-hear audio this decode heard; otherwise it
    # would repeat words committed earlier that dedupe cannot match.
    overlap = min(overlap, boundary - start)
    chunk = AudioChunk(1, 1, start, boundary, committed_end, boundary)
    return chunk, overlap


def is_settled(buffer: AudioBuffer, decode: Decode, total_samples: int) -> bool:
    """True when nothing but silence arrived after ``decode``'s audio.

    A decode that covered all audio is trivially settled. Otherwise it must
    have heard ``SETTLED_GUARD_S`` of non-speech after its last speech (its
    whole window when it heard none). That stretch must be steady noise, and
    every later 20 ms frame must stay within 6 dB of its median. At most
    ``SETTLED_MAX_NEW_S`` of later audio may be covered. When in doubt this
    returns False and the caller decodes again.
    """
    chunk, result = decode.chunk, decode.result
    if total_samples < chunk.end_sample:
        return False
    if total_samples == chunk.end_sample:
        return True
    rate = AUDIO_SAMPLE_RATE
    if total_samples - chunk.end_sample > int(SETTLED_MAX_NEW_S * rate):
        return False
    speech_end = chunk.start_sample
    if result.last_speech_end is not None:
        speech_end = chunk.start_sample + int(result.last_speech_end * rate)
    if chunk.end_sample - speech_end < int(SETTLED_GUARD_S * rate):
        return False
    reference = frame_rms(buffer, speech_end, chunk.end_sample)
    new_audio = frame_rms(buffer, chunk.end_sample, total_samples, include_partial=True)
    if len(reference) == 0 or len(new_audio) == 0:
        return False
    floor = max(float(np.median(reference)), SETTLED_ABS_FLOOR)
    limit = SETTLED_NOISE_RATIO * floor
    if float(np.percentile(reference, 95)) > limit:
        return False  # The "non-speech" stretch holds a transient or speech.
    return float(new_audio.max()) <= limit
