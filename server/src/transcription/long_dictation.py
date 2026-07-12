"""Chunk planning and stitching for long final dictation."""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from protocol.constants import AUDIO_SAMPLE_RATE


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
    audio: NDArray[np.float32],
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
    """Join chunk transcripts and remove exact word overlap at boundaries."""
    stitched = ""
    for chunk_text in chunks:
        text = _normalize_space(chunk_text)
        if not text:
            continue
        if not stitched:
            stitched = text
            continue
        stitched = _append_deduped(stitched, text)
    return _normalize_space(stitched)


def _find_quiet_boundary(
    audio: NDArray[np.float32],
    target_sample: int,
    *,
    sample_rate: int,
    search_s: float,
    window_s: float,
) -> int:
    radius = max(1, int(search_s * sample_rate))
    window = max(1, int(window_s * sample_rate))
    lo = max(window, target_sample - radius)
    hi = min(len(audio) - window, target_sample + radius)
    if lo >= hi:
        return target_sample

    best_pos = target_sample
    best_score: tuple[float, int] | None = None
    step = max(1, window // 2)
    for pos in range(lo, hi + 1, step):
        segment = audio[pos - window:pos + window]
        rms = float(np.sqrt(np.mean(np.square(segment), dtype=np.float64)))
        distance = abs(pos - target_sample)
        score = (rms, distance)
        if best_score is None or score < best_score:
            best_score = score
            best_pos = pos
    return best_pos


def _append_deduped(previous: str, current: str) -> str:
    prev_words = previous.split()
    current_words = current.split()
    overlap = _word_overlap(prev_words, current_words)
    suffix = " ".join(current_words[overlap:])
    if not suffix:
        return previous
    if previous.endswith(("-", "/", "'")):
        return previous + suffix
    return f"{previous} {suffix}"


def _word_overlap(previous_words: list[str], current_words: list[str]) -> int:
    max_overlap = min(24, len(previous_words), len(current_words))
    normalized_previous = [_normalize_word(word) for word in previous_words]
    normalized_current = [_normalize_word(word) for word in current_words]

    for size in range(max_overlap, 0, -1):
        if normalized_previous[-size:] == normalized_current[:size]:
            return size
    return 0


def _normalize_word(word: str) -> str:
    return re.sub(r"(^[^\w]+|[^\w]+$)", "", word.casefold())


def _normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()
