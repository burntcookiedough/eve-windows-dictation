"""FastAPI application factory."""

import asyncio
import logging
import signal
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, WebSocket

from config import get_settings
from session.manager import get_session_manager
from transcription.engine import get_engine, shutdown_engine
from transcription.processor import shutdown_executor
from version import SERVER_VERSION
from websocket.handler import websocket_handler

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan context manager."""
    settings = get_settings()

    # Configure logging
    logging.basicConfig(
        level=getattr(logging, settings.log_level),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    # Reduce noise from faster_whisper (logs every audio chunk at INFO)
    logging.getLogger("faster_whisper").setLevel(logging.WARNING)

    logger.info("Starting murmur...")
    logger.info("Loading Whisper model (this may take a moment)...")

    # Pre-load Whisper model at startup
    get_engine()

    logger.info("Murmur ready")

    yield

    # Shutdown
    logger.info("Shutting down murmur...")
    shutdown_executor()
    shutdown_engine()
    logger.info("Murmur stopped")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="Murmur",
        description="WebSocket-based live voice transcription server",
        version=SERVER_VERSION,
        lifespan=lifespan,
    )

    @app.get("/health")
    async def health_check() -> dict:
        """Health check endpoint."""
        manager = get_session_manager()
        return {
            "status": "healthy",
            "version": SERVER_VERSION,
            "active_sessions": manager.active_count,
            "max_sessions": manager.max_sessions,
        }

    @app.websocket("/transcribe")
    async def transcribe(websocket: WebSocket) -> None:
        """WebSocket endpoint for live transcription."""
        await websocket_handler(websocket)

    @app.post("/shutdown")
    async def shutdown() -> dict:
        """Trigger graceful server shutdown.

        Used by the Electron app to stop the server when managed.
        The endpoint returns immediately, and shutdown occurs after a brief delay.
        """
        logger.info("Shutdown requested via API")

        def trigger_shutdown() -> None:
            # Use SIGINT for cleaner uvicorn shutdown
            signal.raise_signal(signal.SIGINT)

        # Schedule shutdown after response is sent
        asyncio.get_event_loop().call_later(0.5, trigger_shutdown)
        return {"status": "shutting_down"}

    return app
