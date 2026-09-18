"""Regression coverage for public model authentication and safe preparation errors."""

import pytest

from config import Settings
import transcription.engines.whisper as whisper
from transcription.catalog import FASTER_WHISPER_CATALOG
from transcription.errors import safe_engine_preparation_message


@pytest.mark.parametrize(
    ("model", "repo_id"),
    [(str(item.model), item.repo_id) for item in FASTER_WHISPER_CATALOG],
)
def test_public_whisper_builtin_models_resolve_to_registered_upstreams(
    model: str, repo_id: str
) -> None:
    assert whisper._resolve_repo_id(model) == repo_id


@pytest.mark.parametrize(
    "repo_id",
    [item.repo_id for item in FASTER_WHISPER_CATALOG],
)
def test_curated_whisper_presets_force_anonymous_download(
    repo_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    def fake_snapshot_download(requested_repo: str, **kwargs: object) -> str:
        calls.append((requested_repo, kwargs))
        return "cache/snapshot"

    monkeypatch.setattr(whisper, "snapshot_download", fake_snapshot_download)

    assert whisper._download_repo(repo_id) == "cache/snapshot"
    assert calls == [
        (
            repo_id,
            {
                "allow_patterns": [
                    "config.json",
                    "preprocessor_config.json",
                    "model.bin",
                    "tokenizer.json",
                    "vocabulary.*",
                ],
                "max_workers": 1,
                "token": False,
            },
        )
    ]


def test_curated_whisper_sizes_derive_from_the_server_catalog() -> None:
    assert {
        str(item.model): whisper._MODEL_SIZES[str(item.model)]
        for item in FASTER_WHISPER_CATALOG
    } == {str(item.model): item.size_gb for item in FASTER_WHISPER_CATALOG}


def test_custom_whisper_model_preserves_existing_authentication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    def fake_snapshot_download(requested_repo: str, **kwargs: object) -> str:
        calls.append((requested_repo, kwargs))
        return "cache/private-snapshot"

    monkeypatch.setattr(whisper, "snapshot_download", fake_snapshot_download)

    assert whisper._download_repo("private-org/custom-whisper") == (
        "cache/private-snapshot"
    )
    assert calls == [
        (
            "private-org/custom-whisper",
            {
                "allow_patterns": [
                    "config.json",
                    "preprocessor_config.json",
                    "model.bin",
                    "tokenizer.json",
                    "vocabulary.*",
                ],
                "max_workers": 1,
            },
        )
    ]


def test_whisper_snapshot_download_serializes_windows_symlink_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The public download boundary avoids concurrent Windows link creation."""

    def fake_snapshot_download(_repo_id: str, **kwargs: object) -> str:
        if kwargs.get("max_workers") != 1:
            raise OSError(1314, "A required privilege is not held by the client")
        return "cache/serialized-snapshot"

    monkeypatch.setattr(whisper, "snapshot_download", fake_snapshot_download)

    assert whisper._download_repo("Systran/faster-whisper-large-v3") == (
        "cache/serialized-snapshot"
    )


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
    monkeypatch.setattr(whisper, "snapshot_download", unexpected_hub_access)
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


def test_whisper_cuda_marker_does_not_receive_nemotron_wording() -> None:
    message = safe_engine_preparation_message(
        RuntimeError("CUDA runtime DLLs are missing while loading Whisper")
    )

    assert "selected model could not initialize the packaged CUDA runtime" in message
    assert "Nemotron" not in message
