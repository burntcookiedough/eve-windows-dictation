"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
import signal
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, WebSocket
from pydantic import ValidationError

from config import (
    API_KEYS,
    RELOAD_KEYS,
    Settings,
    build_settings_candidate,
    commit_settings,
    get_settings,
    get_settings_with_metadata,
    persist_settings,
    publish_settings,
)
from diagnostics import collect_diagnostics
from legacy_settings import migrate_raw_settings
from session.manager import get_session_manager
from transcription.catalog import model_catalog_payload
from transcription.factory import (
    discover_engines,
    get_model_runtime,
    init_model_runtime,
    runtime_status_to_engine_payload,
    shutdown_model_runtime,
    whisper_config_from_settings,
)
from transcription.model_download import get_model_download_state
from transcription.processor import shutdown_executor
from version import SERVER_VERSION
from websocket.handler import websocket_handler

logger = logging.getLogger(__name__)
_runtime_tasks: set[asyncio.Task[None]] = set()


def _safe_settings_validation_detail(error: ValidationError) -> str:
    """Return a concise validation message without echoing submitted values."""

    errors = error.errors()
    if not errors:
        return "Invalid settings."
    message = str(errors[0].get("msg", "Invalid settings."))
    return message.removeprefix("Value error, ")


def _track_runtime_task(task: asyncio.Task[None]) -> asyncio.Task[None]:
    """Keep a background runtime operation alive and consume its completion."""

    _runtime_tasks.add(task)
    task.add_done_callback(_consume_runtime_task)
    return task


def _consume_runtime_task(task: asyncio.Task[None]) -> None:
    """Release a completed task after retrieving any background failure."""

    _runtime_tasks.discard(task)
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        logger.error(
            "Background model runtime operation failed",
            exc_info=(type(error), error, error.__traceback__),
        )


def _schedule_runtime_start(runtime: Any) -> asyncio.Task[None]:
    """Start initial model preparation without blocking FastAPI startup."""

    return _track_runtime_task(asyncio.create_task(_start_runtime_background(runtime)))


def _schedule_runtime_prepare(
    runtime: Any,
    settings: Settings,
    *,
    commit_on_success: bool = False,
) -> asyncio.Task[None]:
    """Ask ``ModelRuntime`` to reserve and schedule one replacement."""

    if not commit_on_success:
        return _track_runtime_task(asyncio.create_task(runtime.start()))
    return _track_runtime_task(
        runtime.schedule_prepare_and_activate(
            whisper_config_from_settings(settings),
            persist=lambda: persist_settings(settings),
            publish=lambda: publish_settings(settings),
        )
    )


async def _start_runtime_background(runtime: Any) -> None:
    try:
        await runtime.start()
    except Exception:
        # Runtime.status() retains the bounded public failure; keep native
        # details in logs only and allow the liveness endpoint to respond.
        logger.exception("Background Faster-Whisper model preparation failed")


async def _prepare_runtime_background(
    runtime: Any,
    settings: Settings,
    *,
    commit_on_success: bool = False,
) -> None:
    """Prepare a model and publish settings only after disk persistence.

    ``ModelRuntime`` invokes ``persist`` off its state lock and invokes
    ``publish`` while swapping the active generation under the same lock.  The
    split prevents a candidate Settings object from becoming visible while the
    previous model is still active.
    """

    try:
        if commit_on_success:
            await runtime.prepare_and_activate(
                whisper_config_from_settings(settings),
                persist=lambda: persist_settings(settings),
                publish=lambda: publish_settings(settings),
            )
        else:
            await runtime.start()
    except Exception:
        logger.exception("Background Faster-Whisper model preparation failed")


async def _await_runtime_tasks() -> None:
    """Observe every task created by the lifespan before it returns."""

    tasks = tuple(_runtime_tasks)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _runtime_snapshot(runtime: Any) -> tuple[Any, Settings]:
    """Read status/settings as one publication snapshot when supported."""

    snapshot = getattr(runtime, "snapshot", None)
    if callable(snapshot):
        return await asyncio.to_thread(snapshot, get_settings)
    # A small fallback keeps bounded compatibility test doubles useful while
    # production ModelRuntime always takes the atomic path above.
    status = await asyncio.to_thread(runtime.status)
    return status, get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    del app
    settings = get_settings()

    logging.basicConfig(
        level=getattr(logging, settings.log_level),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    # Reduce noise from model libraries and their transitive dependencies.
    for noisy_logger in [
        "faster_whisper",
    ]:
        logging.getLogger(noisy_logger).setLevel(logging.WARNING)

    logger.info("Starting murmur...")
    logger.info("Initializing Faster-Whisper model runtime (load in background)...")

    runtime = init_model_runtime(settings)
    _schedule_runtime_start(runtime)

    logger.info("Murmur ready")
    try:
        yield
    finally:
        logger.info("Shutting down murmur...")
        # Runtime shutdown joins native preparation and drains every generation
        # before returning.  No one-second timeout can strand native work.
        await shutdown_model_runtime()
        await _await_runtime_tasks()
        shutdown_executor()
        logger.info("Murmur stopped")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Murmur",
        description="WebSocket-based live voice transcription server",
        version=SERVER_VERSION,
        lifespan=lifespan,
    )

    def serialize_engine_status(status: Any) -> dict[str, Any]:
        """Keep the historical transport name while using runtime statuses."""

        return runtime_status_to_engine_payload(status)

    @app.get("/health")
    async def health_check() -> dict:
        manager = get_session_manager()
        runtime = get_model_runtime()
        status, settings = await _runtime_snapshot(runtime)
        diagnostics_payload, model_download = await asyncio.gather(
            asyncio.to_thread(collect_diagnostics, settings),
            asyncio.to_thread(get_model_download_state),
        )
        return {
            "status": "healthy",
            "version": SERVER_VERSION,
            "active_sessions": manager.active_count,
            "max_sessions": manager.max_sessions,
            "engine": serialize_engine_status(status),
            "diagnostics": diagnostics_payload,
            "model_download": model_download,
        }

    @app.get("/diagnostics")
    async def diagnostics() -> dict:
        runtime = get_model_runtime()
        status, settings = await _runtime_snapshot(runtime)
        diagnostics_payload, model_download = await asyncio.gather(
            asyncio.to_thread(collect_diagnostics, settings),
            asyncio.to_thread(get_model_download_state),
        )
        return {
            **diagnostics_payload,
            "engine": serialize_engine_status(status),
            "model_download": model_download,
        }

    @app.get("/settings")
    async def get_server_settings() -> dict:
        runtime = get_model_runtime()
        status, settings = await _runtime_snapshot(runtime)

        return {
            "settings": get_settings_with_metadata(settings),
            "engine_status": serialize_engine_status(status),
            "model_catalog": model_catalog_payload(),
        }

    @app.patch("/settings")
    async def update_server_settings(body: dict[str, Any]) -> dict:
        # Filter to only API-managed keys, then run the legacy selector through
        # the migration boundary before strict Settings construction.
        patch = {key: value for key, value in body.items() if key in API_KEYS}
        if not patch:
            raise HTTPException(status_code=400, detail="No valid settings provided")
        outcome = migrate_raw_settings(patch)
        patch = {key: value for key, value in outcome.values.items() if key in API_KEYS}
        if not patch:
            raise HTTPException(status_code=400, detail="No valid settings provided")

        runtime = get_model_runtime()
        runtime_status = await asyncio.to_thread(runtime.status)
        if runtime_status.kind in {"starting", "preparing"}:
            raise HTTPException(
                status_code=409,
                detail="A settings change is already being prepared.",
            )

        needs_reload = bool(set(patch) & RELOAD_KEYS)
        try:
            candidate = build_settings_candidate(patch)
        except ValidationError as error:
            raise HTTPException(
                status_code=400,
                detail=_safe_settings_validation_detail(error),
            ) from error

        reload_started = False
        if needs_reload:
            reload_started = True
            try:
                _schedule_runtime_prepare(runtime, candidate, commit_on_success=True)
            except RuntimeError as error:
                raise HTTPException(
                    status_code=409,
                    detail="A settings change is already being prepared.",
                ) from error
        else:
            try:
                commit_settings(candidate)
            except OSError:
                raise HTTPException(
                    status_code=500,
                    detail="Could not save settings. Please try again.",
                ) from None

        status, committed_settings = await _runtime_snapshot(runtime)
        session_mgr = get_session_manager()
        response: dict[str, Any] = {
            "settings": get_settings_with_metadata(committed_settings),
            "engine_status": serialize_engine_status(status),
            "model_catalog": model_catalog_payload(),
            "reload_required": needs_reload,
            "reload_started": reload_started,
        }
        if session_mgr.active_count > 0 and needs_reload:
            response["active_sessions"] = session_mgr.active_count
            response["note"] = (
                "New model loading in background. Active sessions will finish "
                "with the current model."
            )
        return response

    @app.get("/engines")
    async def get_available_engines() -> dict:
        """Deprecated alias retained for one app/server skew window."""

        runtime = get_model_runtime()
        status = await asyncio.to_thread(runtime.status)
        return {
            "engines": discover_engines(),
            "current": status_to_current_engine(status),
        }

    @app.get("/engine/status")
    async def get_engine_status() -> dict:
        """Deprecated alias for the runtime status serializer."""

        runtime = get_model_runtime()
        status = await asyncio.to_thread(runtime.status)
        return serialize_engine_status(status)

    @app.websocket("/transcribe")
    async def transcribe(websocket: WebSocket) -> None:
        await websocket_handler(websocket)

    @app.post("/shutdown")
    async def shutdown() -> dict:
        logger.info("Shutdown requested via API")

        def trigger_shutdown() -> None:
            signal.raise_signal(signal.SIGINT)

        asyncio.get_event_loop().call_later(0.5, trigger_shutdown)
        return {"status": "shutting_down"}

    return app


def status_to_current_engine(status: Any) -> str:
    """Return the fixed compatibility family ID for any runtime status."""

    del status
    return "whisper"
