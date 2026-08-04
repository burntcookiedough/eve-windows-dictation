"""Regression coverage for public model authentication and safe preparation errors."""

from types import SimpleNamespace

import pytest

from config import Settings
from transcription.engines.nemotron import _public_model_anonymous_access
import transcription.engines.whisper as whisper
from transcription.errors import safe_engine_preparation_message


def test_curated_public_model_forces_anonymous_access_and_restores_token_resolver() -> None:
    def original() -> str:
        return "stale-saved-token"

    hf_common = SimpleNamespace(get_hf_token=original)

    with _public_model_anonymous_access(
        "nvidia/nemotron-speech-streaming-en-0.6b", hf_common
    ):
        assert hf_common.get_hf_token() is False

    assert hf_common.get_hf_token is original


def test_custom_model_preserves_existing_hugging_face_authentication() -> None:
    def original() -> str:
        return "private-model-token"

    hf_common = SimpleNamespace(get_hf_token=original)

    with _public_model_anonymous_access("private-org/custom-asr", hf_common):
        assert hf_common.get_hf_token() == "private-model-token"

    assert hf_common.get_hf_token is original


def test_public_model_token_override_is_restored_after_failure() -> None:
    def original() -> str:
        return "stale-saved-token"

    hf_common = SimpleNamespace(get_hf_token=original)

    with pytest.raises(RuntimeError, match="download failed"):
        with _public_model_anonymous_access(
            "nvidia/nemotron-speech-streaming-en-0.6b", hf_common
        ):
            assert hf_common.get_hf_token() is False
            raise RuntimeError("download failed")

    assert hf_common.get_hf_token is original


@pytest.mark.parametrize(
    ("model", "repo_id"),
    [
        ("large-v3-turbo", "mobiuslabsgmbh/faster-whisper-large-v3-turbo"),
        ("large-v3", "Systran/faster-whisper-large-v3"),
        ("medium", "Systran/faster-whisper-medium"),
        ("small", "Systran/faster-whisper-small"),
        ("tiny", "Systran/faster-whisper-tiny"),
    ],
)
def test_public_whisper_builtin_models_resolve_to_registered_upstreams(
    model: str, repo_id: str
) -> None:
    assert whisper._resolve_repo_id(model) == repo_id


@pytest.mark.parametrize(
    "repo_id",
    [
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
        "Systran/faster-whisper-large-v3",
        "Systran/faster-whisper-medium",
        "Systran/faster-whisper-small",
        "Systran/faster-whisper-tiny",
    ],
)
def test_curated_whisper_presets_force_anonymous_download(
    repo_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, object]] = []

    def fake_download(requested_repo: str, **kwargs: object) -> str:
        calls.append((requested_repo, kwargs.get("use_auth_token")))
        return "cache/snapshot"

    monkeypatch.setattr(whisper, "download_model", fake_download)

    assert whisper._download_repo(repo_id) == "cache/snapshot"
    assert calls == [(repo_id, False)]


def test_custom_whisper_model_preserves_existing_authentication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    def fake_download(requested_repo: str, **kwargs: object) -> str:
        calls.append((requested_repo, kwargs))
        return "cache/private-snapshot"

    monkeypatch.setattr(whisper, "download_model", fake_download)

    assert whisper._download_repo("private-org/custom-whisper") == (
        "cache/private-snapshot"
    )
    assert calls == [("private-org/custom-whisper", {})]


def test_local_whisper_path_skips_hub_resolution_and_download(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    local_model = tmp_path / "local-whisper-model"
    local_model.mkdir()
    model_sources: list[str] = []

    class FakeWhisperModel:
        def __init__(self, model_source: str, **_kwargs: object) -> None:
            model_sources.append(model_source)

    def unexpected_hub_access(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("local paths must not access the Hub")

    monkeypatch.setattr(whisper, "get_repo_cache_status", unexpected_hub_access)
    monkeypatch.setattr(whisper, "download_model", unexpected_hub_access)
    monkeypatch.setattr(whisper, "WhisperModel", FakeWhisperModel)
    monkeypatch.setattr(whisper, "_get_cuda_active", lambda _device: False)

    whisper.WhisperEngine(
        Settings(
            whisper_model=str(local_model),
            whisper_device="cpu",
            whisper_compute_type="int8",
        )
    )

    assert model_sources == [str(local_model)]


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
