"""Entry point for running the murmur with uvicorn."""

import logging
import os
import socket

import uvicorn

from config import get_settings
from pidfile import register_cleanup, remove_pid_file, write_pid_file
from version import SERVER_VERSION


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
    logger = logging.getLogger(__name__)
    logger.info("Murmur server version %s", SERVER_VERSION)

    # Uvicorn log level: use app level only if log_binary is enabled,
    # otherwise keep uvicorn at INFO to suppress WebSocket frame spam
    uvicorn_log_level = settings.log_level.lower() if settings.log_binary else "info"

    listen_socket: socket.socket | None = None
    listen_port = settings.port

    if settings.port == 0:
        # Pre-bind to an OS-assigned port so we can persist the actual port.
        listen_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listen_socket.bind((settings.host, 0))
        listen_socket.listen(socket.SOMAXCONN)
        listen_port = int(listen_socket.getsockname()[1])

    # Write PID file and register cleanup
    write_pid_file(os.getpid(), listen_port)
    register_cleanup()

    try:
        if listen_socket is not None:
            server = uvicorn.Server(
                uvicorn.Config(
                    "app:create_app",
                    factory=True,
                    host=settings.host,
                    port=listen_port,
                    log_level=uvicorn_log_level,
                )
            )
            server.run(sockets=[listen_socket])
        else:
            uvicorn.run(
                "app:create_app",
                factory=True,
                host=settings.host,
                port=listen_port,
                log_level=uvicorn_log_level,
            )
    finally:
        if listen_socket is not None:
            listen_socket.close()
        # Ensure PID file is removed even if uvicorn exits abnormally
        remove_pid_file()


if __name__ == "__main__":
    main()
