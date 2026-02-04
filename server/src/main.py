"""Entry point for running the murmur with uvicorn."""

import logging
import os

import uvicorn

from config import get_settings
from pidfile import register_cleanup, remove_pid_file, write_pid_file


def configure_logging(log_level: str) -> None:
    """Configure logging for application loggers.

    Args:
        log_level: Log level for application loggers (DEBUG, INFO, etc.)
    """
    # Set up root logger
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )

    # Set application loggers to requested level
    for name in ["websocket", "session", "audio", "transcription", "protocol"]:
        logging.getLogger(name).setLevel(log_level)


def main() -> None:
    """Run the murmur."""
    settings = get_settings()

    # Configure logging before uvicorn starts
    configure_logging(settings.log_level)

    # Write PID file and register cleanup
    write_pid_file(os.getpid(), settings.port)
    register_cleanup()

    # Uvicorn log level: use app level only if log_binary is enabled,
    # otherwise keep uvicorn at INFO to suppress WebSocket frame spam
    uvicorn_log_level = settings.log_level.lower() if settings.log_binary else "info"

    try:
        uvicorn.run(
            "app:create_app",
            factory=True,
            host=settings.host,
            port=settings.port,
            log_level=uvicorn_log_level,
        )
    finally:
        # Ensure PID file is removed even if uvicorn exits abnormally
        remove_pid_file()


if __name__ == "__main__":
    main()
