"""Compatibility boundary for settings written by the removed Nemotron family.

The settings model is intentionally strict.  This module keeps old persisted
and environment values outside that model, translates the small compatibility
surface that is still supported, and removes fields that no longer have a
meaning in the Faster-Whisper runtime.

Keep this module small and temporary.  It is the only production code that
should know the removed field names; callers receive ordinary canonical
settings values and never a Nemotron model identifier.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Final

RECOMMENDED_WHISPER_MODEL: Final[str] = "large-v3-turbo"
KNOWN_NEMOTRON_MODEL: Final[str] = "nvidia/nemotron-speech-streaming-en-0.6b"

_LEGACY_MODEL_KEY: Final[str] = "nemotron_model"
_LEGACY_DEVICE_KEY: Final[str] = "nemotron_device"
_ENGINE_KEY: Final[str] = "engine"
_LEGACY_ENGINE_PREFERENCE_KEY: Final[str] = "engine_preference_mode"
_LEGACY_UNLOAD_KEY: Final[str] = "unload_before_swap"
_LEGACY_COMPUTE_TYPE: Final[str] = "int16"

# Pydantic's OS environment source only returns fields that still exist on the
# strict Settings model.  Keep the legacy aliases here so MURMUR_* values remain
# migratable after those fields are removed from Settings in the next unit.
LEGACY_ENVIRONMENT_FIELDS: Final[dict[str, str]] = {
    "MURMUR_ENGINE": _ENGINE_KEY,
    "MURMUR_ENGINE_PREFERENCE_MODE": _LEGACY_ENGINE_PREFERENCE_KEY,
    "MURMUR_NEMOTRON_MODEL": _LEGACY_MODEL_KEY,
    "MURMUR_NEMOTRON_DEVICE": _LEGACY_DEVICE_KEY,
    "MURMUR_UNLOAD_BEFORE_SWAP": _LEGACY_UNLOAD_KEY,
}

_LEGACY_ENGINE_NAMES: Final[frozenset[str]] = frozenset(
    {"nemotron", "nemo", "nemo_asr", "nemotron_speech"}
)


@dataclass(frozen=True, slots=True)
class MigrationOutcome:
    """Canonical values and bounded information about a source migration."""

    values: dict[str, Any]
    migrated: bool
    diagnostic: str | None


def _normalise_key(key: object) -> object:
    """Match source keys case-insensitively without changing unknown keys."""

    if not isinstance(key, str):
        return key
    lowered = key.casefold()
    aliases = {
        name: name
        for name in (
            _ENGINE_KEY,
            _LEGACY_ENGINE_PREFERENCE_KEY,
            _LEGACY_UNLOAD_KEY,
            _LEGACY_MODEL_KEY,
            _LEGACY_DEVICE_KEY,
            "whisper_model",
            "whisper_device",
            "whisper_compute_type",
        )
    }
    aliases.update(
        {
            environment_name.casefold(): field_name
            for environment_name, field_name in LEGACY_ENVIRONMENT_FIELDS.items()
        }
    )
    return aliases.get(lowered, key)


def _normalise_source_values(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Copy a source and normalise only keys that belong to this boundary."""

    values: dict[str, Any] = {}
    for key, value in raw.items():
        normalised = _normalise_key(key)
        # A source can contain both differently-cased spellings.  Preserve the
        # last value, matching normal mapping update semantics, while ensuring
        # legacy environment names become field names.
        if isinstance(normalised, str):
            values[normalised] = value
        else:
            values[key] = value
    return values


def _engine_name(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    return value.strip().casefold() or None


def _has_nemotron_marker(value: object) -> bool:
    """Identify a custom Nemotron selection without retaining its value."""

    name = _engine_name(value)
    return bool(name and ("nemotron" in name or name in {"nemo", "nemo_asr"}))


def _bounded_diagnostic(kind: str) -> str:
    """Return a stable diagnostic that contains no user value or filesystem path."""

    if kind == "custom":
        return (
            "Unsupported custom Nemotron model setting ignored; using "
            "Faster-Whisper large-v3-turbo."
        )
    if kind == "invalid-engine":
        return (
            "Unsupported legacy engine setting ignored; using "
            "Faster-Whisper large-v3-turbo."
        )
    if kind == "precision":
        return "Legacy Whisper precision setting migrated to auto."
    if kind == "stale-field":
        return "Removed Nemotron settings ignored; existing Whisper preferences kept."
    return "Legacy Nemotron settings migrated to Faster-Whisper large-v3-turbo."


def migrate_raw_settings(raw: Mapping[str, Any]) -> MigrationOutcome:
    """Translate one raw settings source before strict validation.

    The returned mapping is a fresh copy.  A legacy Nemotron engine selection
    (including a custom model value) always selects the recommended Whisper
    model.  Custom values are deliberately not copied into ``whisper_model`` or
    diagnostics.  Existing Whisper/general settings are left untouched.
    """

    if not isinstance(raw, Mapping):
        return MigrationOutcome(
            values={},
            migrated=False,
            diagnostic="Settings source ignored because it is not an object.",
        )

    values = _normalise_source_values(raw)
    original_keys = set(values)
    engine_seen = _ENGINE_KEY in values
    engine = _engine_name(values.get(_ENGINE_KEY))
    model_seen = _LEGACY_MODEL_KEY in values
    device_seen = _LEGACY_DEVICE_KEY in values
    canonical_whisper_model = values.get("whisper_model")
    has_canonical_whisper_model = (
        isinstance(canonical_whisper_model, str) and bool(canonical_whisper_model.strip())
    )
    removed_fields_seen = bool(
        original_keys
        & {
            _LEGACY_MODEL_KEY,
            _LEGACY_DEVICE_KEY,
            _LEGACY_ENGINE_PREFERENCE_KEY,
            _LEGACY_UNLOAD_KEY,
        }
    )
    legacy_model = values.get(_LEGACY_MODEL_KEY)
    migration_kind: str | None = None

    # Removed fields must not cross the boundary.  Keep the rest of the raw
    # source intact so unrelated preferences survive validation and rewrite.
    for key in (
        _LEGACY_MODEL_KEY,
        _LEGACY_DEVICE_KEY,
        _LEGACY_ENGINE_PREFERENCE_KEY,
        _LEGACY_UNLOAD_KEY,
    ):
        values.pop(key, None)

    named_legacy_engine = engine in _LEGACY_ENGINE_NAMES
    custom_legacy_engine = _has_nemotron_marker(engine) and not named_legacy_engine
    legacy_engine = named_legacy_engine or custom_legacy_engine
    invalid_engine = engine_seen and engine != "whisper" and not legacy_engine

    # A stale Nemotron field alongside an explicit Whisper selection is
    # harmless once removed; do not discard the user's current Whisper model.
    inferred_legacy_selection = model_seen and engine is None
    if legacy_engine or inferred_legacy_selection:
        # The engine field remains as a short-lived compatibility value until
        # the caller migration removes it.  It is always the supported value;
        # no Nemotron identifier is handed to Settings or the runtime.
        values[_ENGINE_KEY] = "whisper"
        # An explicit canonical model wins when the removed field is merely
        # stale.  A named legacy engine still represents an intentional old
        # selection and receives the recommended Whisper replacement.
        if legacy_engine or not has_canonical_whisper_model:
            values["whisper_model"] = RECOMMENDED_WHISPER_MODEL
        if inferred_legacy_selection and has_canonical_whisper_model:
            migration_kind = "stale-field"
        elif custom_legacy_engine or (
            model_seen
            and (
                not isinstance(legacy_model, str)
                or legacy_model.strip().casefold() != KNOWN_NEMOTRON_MODEL.casefold()
            )
        ):
            migration_kind = "custom"
        else:
            migration_kind = "legacy"
    elif model_seen:
        migration_kind = "custom" if (
            not isinstance(legacy_model, str)
            or legacy_model.strip().casefold() != KNOWN_NEMOTRON_MODEL.casefold()
        ) else "stale-field"
    elif invalid_engine:
        # A value in the removed selector is not a model ID.  Treat it as an
        # unsupported legacy selection so one bad value cannot reset the rest
        # of a user's configuration through whole-object fallback.
        values[_ENGINE_KEY] = "whisper"
        values["whisper_model"] = RECOMMENDED_WHISPER_MODEL
        migration_kind = "invalid-engine"
    elif device_seen:
        migration_kind = "stale-field"

    # Any removed field is canonicalized away even when it accompanies an
    # already-valid Whisper selection.  Supplying a retired field also makes
    # the compatibility engine explicit so the strict settings model receives
    # one stable value instead of inheriting a legacy default.
    if removed_fields_seen:
        values[_ENGINE_KEY] = "whisper"
        migration_kind = migration_kind or "stale-field"

    if values.get("whisper_compute_type") == _LEGACY_COMPUTE_TYPE:
        values["whisper_compute_type"] = "auto"
        migration_kind = migration_kind or "precision"

    migrated = bool(migration_kind) or removed_fields_seen
    diagnostic = _bounded_diagnostic(migration_kind) if migrated else None
    return MigrationOutcome(values=values, migrated=migrated, diagnostic=diagnostic)


def migrate_persisted_settings(raw: Mapping[str, Any]) -> MigrationOutcome:
    """Documented persisted-settings entry point for the generic raw seam."""

    return migrate_raw_settings(raw)


def legacy_environment_values(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return removed ``MURMUR_*`` environment values as field-name mappings."""

    source = os.environ if environ is None else environ
    values: dict[str, str] = {}
    wanted = {name.casefold(): field for name, field in LEGACY_ENVIRONMENT_FIELDS.items()}
    for name, value in source.items():
        field = wanted.get(name.casefold())
        if field is not None:
            values[field] = value
    return values


def rewrite_settings_file(settings_file: Path, values: Mapping[str, Any]) -> None:
    """Atomically replace a migrated JSON file, preserving the old file on error."""

    temp_path: Path | None = None
    try:
        settings_file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=settings_file.parent,
            prefix=f".{settings_file.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            json.dump(dict(values), handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, settings_file)
    except (OSError, TypeError, ValueError):
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


__all__ = [
    "KNOWN_NEMOTRON_MODEL",
    "LEGACY_ENVIRONMENT_FIELDS",
    "MigrationOutcome",
    "RECOMMENDED_WHISPER_MODEL",
    "legacy_environment_values",
    "migrate_persisted_settings",
    "migrate_raw_settings",
    "rewrite_settings_file",
]
