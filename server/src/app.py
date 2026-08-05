"""FastAPI application factory."""

import asyncio
import logging
import signal
from contextlib import asynccontextmanager
from dataclasses import asdict
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
)
from diagnostics import collect_diagnostics
from session.manager import get_session_manager
from transcription.factory import (
    discover_engines,
    get_engine_manager,
    init_engine_manager,
    shutdown_engine_manager,
)
from transcription.model_download import get_model_download_state
from transcription.processor import shutdown_executor
from version import SERVER_VERSION
from websocket.handler import websocket_handler

logger = logging.getLogger(__name__)
_engine_tasks: set[asyncio.Task[None]] = set()
_settings_preparation_pending = False


def _safe_settings_validation_detail(error: ValidationError) -> str:
    """Return a concise validation message without echoing submitted values."""
    errors = error.errors()
    if not errors:
        return "Invalid settings."
    message = str(errors[0].get("msg", "Invalid settings."))
    return message.removeprefix("Value error, ")


def _schedule_engine_swap(
    engine_mgr: Any, settings: Settings, *, commit_on_success: bool = False
) -> asyncio.Task[None]:
    """Keep background engine loads alive and observe their completion."""
    task = asyncio.create_task(
        _swap_engine_background(
            engine_mgr, settings, commit_on_success=commit_on_success
        )
    )
    _engine_tasks.add(task)
    task.add_done_callback(_engine_tasks.discard)
    return task


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()

    logging.basicConfig(
        level=getattr(logging, settings.log_level),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    # Reduce noise from engine libraries and their transitive dependencies
    for noisy_logger in [
        "faster_whisper", "nemo_logger", "matplotlib", "matplotlib.font_manager",
        "graphviz", "graphviz._tools", "torio", "torio._extension",
        "datasets", "numexpr", "nv_one_logger",
        "lhotse", "lhotse.cut", "lhotse.dataset",
        "nemo", "nemo.collections",
    ]:
        logging.getLogger(noisy_logger).setLevel(logging.WARNING)

    logger.info("Starting murmur...")
    logger.info("Initializing engine manager (engine loads in background)...")

    engine_mgr = init_engine_manager(settings, load_engine=False)
    _schedule_engine_swap(engine_mgr, settings)

    logger.info("Murmur ready")

    yield

    logger.info("Shutting down murmur...")
    shutdown_engine_manager()
    shutdown_executor()
    if _engine_tasks:
        _, pending = await asyncio.wait(tuple(_engine_tasks), timeout=1.0)
        if pending:
            logger.info(
                "Waiting for %d background engine load(s) to leave native code",
                len(pending),
            )
    logger.info("Murmur stopped")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Murmur",
        description="WebSocket-based live voice transcription server",
        version=SERVER_VERSION,
        lifespan=lifespan,
    )

    def serialize_engine_status(status: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "current": status.current,
            "status": status.status,
            "info": asdict(status.info) if status.info else None,
        }
        if status.pending:
            payload["pending"] = status.pending
        if status.message:
            payload["message"] = status.message
        return payload

    @app.get("/health")
    async def health_check() -> dict:
        manager = get_session_manager()
        engine_mgr = get_engine_manager()
        status = engine_mgr.get_status()
        settings = get_settings()
        return {
            "status": "healthy",
            "version": SERVER_VERSION,
            "active_sessions": manager.active_count,
            "max_sessions": manager.max_sessions,
            "engine": serialize_engine_status(status),
            "diagnostics": collect_diagnostics(settings),
            "model_download": get_model_download_state(),
        }

    @app.get("/diagnostics")
    async def diagnostics() -> dict:
        settings = get_settings()
        engine_mgr = get_engine_manager()
        return {
            **collect_diagnostics(settings),
            "engine": serialize_engine_status(engine_mgr.get_status()),
            "model_download": get_model_download_state(),
        }

    @app.get("/settings")
    async def get_server_settings() -> dict:
        settings = get_settings()
        engine_mgr = get_engine_manager()
        status = engine_mgr.get_status()
        available = [e["id"] for e in discover_engines() if e["available"]]

        return {
            "settings": get_settings_with_metadata(settings),
            "engine_status": serialize_engine_status(status),
            "available_engines": available,
        }

    @app.patch("/settings")
    async def update_server_settings(body: dict[str, Any]) -> dict:
        global _settings_preparation_pending
        # Filter to only API-managed keys
        patch = {k: v for k, v in body.items() if k in API_KEYS}
        if not patch:
            raise HTTPException(status_code=400, detail="No valid settings provided")
        if _settings_preparation_pending:
            raise HTTPException(
                status_code=409,
                detail="A settings change is already being prepared.",
            )

        discovered_engines = discover_engines()
        available_engines = [e["id"] for e in discovered_engines if e["available"]]
        discovered_by_id = {e["id"]: e for e in discovered_engines}

        # Track explicit engine overrides separately from default/auto selection.
        if "engine" in patch:
            requested_engine = str(patch["engine"])
            if requested_engine not in available_engines:
                detail = f'Engine "{requested_engine}" is not available on this server.'
                install_hint = discovered_by_id.get(requested_engine, {}).get("install_hint")
                if install_hint:
                    detail = f"{detail} Install with: {install_hint}"
                raise HTTPException(status_code=400, detail=detail)
            if "engine_preference_mode" not in patch:
                patch["engine_preference_mode"] = "manual"

        # Check if reload is needed
        needs_reload = bool(set(patch.keys()) & RELOAD_KEYS)

        try:
            candidate = build_settings_candidate(patch)
        except ValidationError as e:
            raise HTTPException(
                status_code=400, detail=_safe_settings_validation_detail(e)
            ) from e
        engine_mgr = get_engine_manager()

        reload_started = False
        if needs_reload:
            reload_started = True
            _settings_preparation_pending = True
            _schedule_engine_swap(engine_mgr, candidate, commit_on_success=True)
            committed_settings = get_settings()
        else:
            try:
                committed_settings = commit_settings(candidate)
            except OSError:
                raise HTTPException(
                    status_code=500,
                    detail="Could not save settings. Please try again.",
                )

        status = engine_mgr.get_status()
        session_mgr = get_session_manager()

        response: dict[str, Any] = {
            "settings": get_settings_with_metadata(committed_settings),
            "engine_status": serialize_engine_status(status),
            "available_engines": available_engines,
            "reload_required": needs_reload,
            "reload_started": reload_started,
        }

        if session_mgr.active_count > 0 and needs_reload:
            response["active_sessions"] = session_mgr.active_count
            response["note"] = "New engine loading in background. Active sessions will finish with current engine."

        return response

    @app.get("/engines")
    async def get_available_engines() -> dict:
        engines = discover_engines()
        engine_mgr = get_engine_manager()
        status = engine_mgr.get_status()
        return {
            "engines": engines,
            "current": status.current,
        }

    @app.get("/engine/status")
    async def get_engine_status() -> dict:
        engine_mgr = get_engine_manager()
        status = engine_mgr.get_status()
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


async def _swap_engine_background(
    engine_mgr: Any, settings: Settings, *, commit_on_success: bool = False
) -> None:
    global _settings_preparation_pending
    try:
        def persist_candidate() -> None:
            commit_settings(settings)

        before_activate = persist_candidate if commit_on_success else None
        await engine_mgr.swap_engine(settings, before_activate=before_activate)
    except Exception as e:
        logger.error("Background engine swap failed: %s", e)
    finally:
        if commit_on_success:
            _settings_preparation_pending = False
