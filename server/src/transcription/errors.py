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


_AUTH_ERROR_MARKERS = (
    "oauth token signature",
    "invalid token",
    "401 client error",
    "unauthorized",
)
_REPOSITORY_ERROR_MARKERS = (
    "repository not found",
    "gated repo",
    "cannot access gated repo",
)
_OFFLINE_ERROR_MARKERS = (
    "outgoing traffic has been disabled",
    "offline mode",
    "offline mode is enabled",
)
_NETWORK_ERROR_MARKERS = (
    "connectionerror",
    "connection error",
    "connection refused",
    "connection reset",
    "timed out",
    "timeout",
    "certificate",
    "tls",
    "ssl",
)


def _exception_text(exc: BaseException) -> str:
    """Collect exception causes for classification without exposing them to clients."""
    seen: set[int] = set()
    pending: list[BaseException | None] = [exc]
    messages: list[str] = []
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        messages.append(str(current))
        pending.extend((current.__cause__, current.__context__))
    return "\n".join(messages).lower()


def safe_engine_preparation_message(exc: BaseException) -> str:
    """Return a stable user-facing engine error while logs retain the raw exception."""
    text = _exception_text(exc)
    if any(marker in text for marker in _AUTH_ERROR_MARKERS):
        return (
            "Hugging Face authentication failed while preparing this model. "
            "Check access for an Advanced model, then retry or revert."
        )
    if any(marker in text for marker in _REPOSITORY_ERROR_MARKERS):
        return (
            "The selected model repository could not be accessed. "
            "Check its name and access requirements, then retry or revert."
        )
    if any(marker in text for marker in _OFFLINE_ERROR_MARKERS):
        return (
            "This model is not fully cached and Eve is offline. "
            "Connect to the internet, then retry or revert."
        )
    if any(marker in text for marker in _NETWORK_ERROR_MARKERS):
        return (
            "Eve could not reach the model provider. "
            "Check your connection, then retry or revert."
        )
    return "The selected speech model could not be prepared. Retry or revert and review diagnostics if it continues."
