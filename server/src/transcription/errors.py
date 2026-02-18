"""Transcription-specific error types."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from transcription.types import TranscribeResult


class RecoverableTranscriptionError(RuntimeError):
    """A non-fatal transcription failure that should not end the session."""

    def __init__(
        self,
        *,
        code: str,
        message: str,
        last_result: "TranscribeResult | None" = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.last_result = last_result


class VramExhaustedError(RecoverableTranscriptionError):
    """Raised when CUDA runs out of VRAM during transcription."""

    def __init__(self, *, last_result: "TranscribeResult | None" = None) -> None:
        super().__init__(
            code="vram_exhausted",
            message="GPU VRAM exhausted during transcription; using last successful result.",
            last_result=last_result,
        )
