"""Chunk planning and stitching for long final dictation."""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from audio.buffer import AudioBuffer
from protocol.constants import AUDIO_SAMPLE_RATE
from transcription.types import TranscribeResult


@dataclass(frozen=True, slots=True)
class AudioChunk:
    index: int
    total: int
    start_sample: int
    end_sample: int
    logical_start_sample: int
    logical_end_sample: int

    @property
    def start_s(self) -> float:
        return self.start_sample / AUDIO_SAMPLE_RATE

    @property
    def end_s(self) -> float:
        return self.end_sample / AUDIO_SAMPLE_RATE

    @property
    def duration_s(self) -> float:
        return (self.end_sample - self.start_sample) / AUDIO_SAMPLE_RATE

    @property
    def logical_duration_s(self) -> float:
        return (self.logical_end_sample - self.logical_start_sample) / AUDIO_SAMPLE_RATE


def plan_chunks(
    audio: NDArray[np.float32] | AudioBuffer,
    *,
    chunk_s: float,
    overlap_s: float,
    sample_rate: int = AUDIO_SAMPLE_RATE,
    silence_search_s: float = 1.5,
    silence_window_s: float = 0.12,
) -> list[AudioChunk]:
    """Plan mostly fixed chunks, nudging boundaries to nearby low-energy audio."""
    if len(audio) == 0:
        return []

    chunk_samples = max(1, int(chunk_s * sample_rate))
    overlap_samples = max(0, int(overlap_s * sample_rate))
    total_samples = len(audio)

    logical_ranges: list[tuple[int, int]] = []
    logical_start = 0
    while logical_start < total_samples:
        target_end = min(total_samples, logical_start + chunk_samples)
        if target_end < total_samples:
            target_end = _find_quiet_boundary(
                audio,
                target_end,
                sample_rate=sample_rate,
                search_s=silence_search_s,
                window_s=silence_window_s,
            )
            target_end = max(logical_start + sample_rate, target_end)
        logical_ranges.append((logical_start, target_end))
        logical_start = target_end

    chunks: list[AudioChunk] = []
    total = len(logical_ranges)
    for index, (logical_start_sample, logical_end_sample) in enumerate(logical_ranges, start=1):
        start_sample = logical_start_sample
        if index > 1:
            start_sample = max(0, logical_start_sample - overlap_samples)
        chunks.append(
            AudioChunk(
                index=index,
                total=total,
                start_sample=start_sample,
                end_sample=logical_end_sample,
                logical_start_sample=logical_start_sample,
                logical_end_sample=logical_end_sample,
            )
        )
    return chunks


def stitch_text(chunks: list[str]) -> str:
    """Join retained text; equal words alone do not prove duplicate speech."""
    return _normalize_space(" ".join(chunks))


def text_for_chunk(
    result: TranscribeResult,
    chunk: AudioChunk,
    previous: tuple[AudioChunk, TranscribeResult] | None = None,
) -> str:
    """Remove only matching segments at demonstrated overlapping audio times.

    A segment crossing the overlap boundary is ambiguous: retain it rather
    than deleting potentially intentional words. No decoder defaults change.
    """
    overlap_end = (chunk.logical_start_sample - chunk.start_sample) / AUDIO_SAMPLE_RATE
    if overlap_end <= 0 or not result.segments or previous is None:
        return result.text
    previous_chunk, previous_result = previous

    def already_transcribed(segment) -> bool:
        if not (0 <= segment.start <= segment.end <= overlap_end):
            return False
        start, end = chunk.start_s + segment.start, chunk.start_s + segment.end
        return any(
            _normalize_space(segment.text).casefold() == _normalize_space(old.text).casefold()
            and start < previous_chunk.start_s + old.end
            and end > previous_chunk.start_s + old.start
            for old in previous_result.segments
        )

    return stitch_text([
        segment.text for segment in result.segments
        if not already_transcribed(segment)
    ])


def _find_quiet_boundary(
    audio: NDArray[np.float32] | AudioBuffer,
    target_sample: int,
    *,
    sample_rate: int,
    search_s: float,
    window_s: float,
) -> int:
    radius = max(1, int(search_s * sample_rate))
    window = max(1, int(window_s * sample_rate))
    total_samples = len(audio)
    lo = max(window, target_sample - radius)
    hi = min(total_samples - window, target_sample + radius)
    if lo >= hi:
        return target_sample

    # Bounded cached search window: one read covers [lo - window : hi + window]
    search_start = lo - window
    search_end = hi + window
    if isinstance(audio, AudioBuffer):
        window_audio = audio.get_audio_range_float32(search_start, search_end)
    else:
        window_audio = audio[search_start:search_end]

    best_pos = target_sample
    best_score: tuple[float, int] | None = None
    step = max(1, window // 2)
    for pos in range(lo, hi + 1, step):
        rel = pos - search_start
        segment = window_audio[rel - window:rel + window]
        rms = float(np.sqrt(np.mean(np.square(segment), dtype=np.float64)))
        distance = abs(pos - target_sample)
        score = (rms, distance)
        if best_score is None or score < best_score:
            best_score = score
            best_pos = pos
    return best_pos


def _normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()
