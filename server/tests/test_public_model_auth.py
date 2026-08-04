"""Regression coverage for public model authentication and safe preparation errors."""

from types import SimpleNamespace

import pytest

from transcription.engines.nemotron import _public_model_anonymous_access
from transcription.errors import safe_engine_preparation_message


def test_curated_public_model_forces_anonymous_access_and_restores_token_resolver() -> None:
    original = lambda: "stale-saved-token"
    hf_common = SimpleNamespace(get_hf_token=original)

    with _public_model_anonymous_access(
        "nvidia/nemotron-speech-streaming-en-0.6b", hf_common
    ):
        assert hf_common.get_hf_token() is False

    assert hf_common.get_hf_token is original


def test_custom_model_preserves_existing_hugging_face_authentication() -> None:
    original = lambda: "private-model-token"
    hf_common = SimpleNamespace(get_hf_token=original)

    with _public_model_anonymous_access("private-org/custom-asr", hf_common):
        assert hf_common.get_hf_token() == "private-model-token"

    assert hf_common.get_hf_token is original


def test_public_model_token_override_is_restored_after_failure() -> None:
    original = lambda: "stale-saved-token"
    hf_common = SimpleNamespace(get_hf_token=original)

    with pytest.raises(RuntimeError, match="download failed"):
        with _public_model_anonymous_access(
            "nvidia/nemotron-speech-streaming-en-0.6b", hf_common
        ):
            assert hf_common.get_hf_token() is False
            raise RuntimeError("download failed")

    assert hf_common.get_hf_token is original


@pytest.mark.parametrize(
    ("raw_error", "expected"),
    [
        (
            "401 Client Error: Repository Not Found; OAuth token signature verification failed",
            "Hugging Face authentication failed",
        ),
        ("Cannot access gated repo", "model repository could not be accessed"),
        ("Outgoing traffic has been disabled", "Eve is offline"),
        ("TLS certificate verification failed", "could not reach the model provider"),
        ("C:/private/path/native-loader.dll exploded", "could not be prepared"),
    ],
)
def test_engine_preparation_errors_are_classified_without_leaking_provider_details(
    raw_error: str,
    expected: str,
) -> None:
    message = safe_engine_preparation_message(RuntimeError(raw_error))

    assert expected in message
    assert "http" not in message.lower()
    assert "request id" not in message.lower()
    assert "c:/" not in message.lower()
