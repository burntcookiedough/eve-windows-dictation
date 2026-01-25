"""FastAPI application factory."""

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, WebSocket

from voiceserver.config import get_settings
from voiceserver.session.manager import get_session_manager
from voiceserver.transcription.engine import get_engine, shutdown_engine
from voiceserver.transcription.processor import shutdown_executor
from voiceserver.websocket.handler import websocket_handler

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

    logger.info("Starting voiceserver...")
    logger.info("Loading Whisper model (this may take a moment)...")

    # Pre-load Whisper model at startup
    get_engine()

    logger.info("Voiceserver ready")

    yield

    # Shutdown
    logger.info("Shutting down voiceserver...")
    shutdown_executor()
    shutdown_engine()
    logger.info("Voiceserver stopped")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="Voiceserver",
        description="WebSocket-based live voice transcription server",
        version="0.1.0",
        lifespan=lifespan,
    )

    @app.get("/health")
    async def health_check() -> dict:
        """Health check endpoint."""
        manager = get_session_manager()
        return {
            "status": "healthy",
            "active_sessions": manager.active_count,
            "max_sessions": manager.max_sessions,
        }

    @app.websocket("/transcribe")
    async def transcribe(websocket: WebSocket) -> None:
        """WebSocket endpoint for live transcription."""
        await websocket_handler(websocket)

    return app
