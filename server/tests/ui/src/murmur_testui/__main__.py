"""Entry point for the test client."""

import argparse
import logging
import sys
import threading
import traceback
from pathlib import Path

from PySide6.QtWidgets import QApplication

from .app import TestClientApp, setup_dark_theme

_logger = logging.getLogger("murmur_testui")


class FlushingStreamHandler(logging.StreamHandler):
    """StreamHandler that flushes after every emit."""
    def emit(self, record):
        super().emit(record)
        self.flush()


def setup_logging(verbose: bool = False) -> None:
    """Configure logging to console with immediate flushing."""
    level = logging.DEBUG if verbose else logging.INFO

    # Create a flushing handler
    handler = FlushingStreamHandler(sys.stdout)
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    ))

    # Configure root logger
    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()
    root.addHandler(handler)


def setup_exception_hooks() -> None:
    """Set up global exception hooks to catch crashes."""
    def handle_exception(exc_type, exc_value, exc_tb):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_tb)
            return
        _logger.critical(
            "Uncaught exception",
            exc_info=(exc_type, exc_value, exc_tb)
        )
        print("FATAL: Uncaught exception:", file=sys.stderr, flush=True)
        traceback.print_exception(exc_type, exc_value, exc_tb, file=sys.stderr)
        sys.stderr.flush()

    def handle_thread_exception(args):
        _logger.critical(
            "Uncaught exception in thread %s",
            args.thread.name if args.thread else "unknown",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback)
        )
        print(f"FATAL: Uncaught exception in thread:", file=sys.stderr, flush=True)
        traceback.print_exception(args.exc_type, args.exc_value, args.exc_traceback, file=sys.stderr)
        sys.stderr.flush()

    sys.excepthook = handle_exception
    threading.excepthook = handle_thread_exception


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Voice Transcription Test Client",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--host",
        default="localhost",
        help="Server host",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=51717,
        help="Server port",
    )
    parser.add_argument(
        "--log-file",
        type=Path,
        default=None,
        help="Path to log file (optional)",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose (debug) logging",
    )
    return parser.parse_args()


def main() -> int:
    """Run the test client application."""
    args = parse_args()

    # Set up console logging first
    setup_logging(verbose=args.verbose)

    # Set up exception hooks to catch crashes
    setup_exception_hooks()

    _logger.info("Starting Voice Transcription Test Client")

    # Build default URL from host/port
    default_url = f"ws://{args.host}:{args.port}/transcribe"

    # Create Qt application
    app = QApplication(sys.argv)
    app.setApplicationName("Voice Transcription Test Client")

    # Log when app is about to quit
    app.aboutToQuit.connect(lambda: _logger.info("Application aboutToQuit signal received"))

    # Apply dark theme
    setup_dark_theme(app)

    # Create and show main app
    client_app = TestClientApp(log_file=args.log_file)

    # Set default URL from args
    client_app._window.url_input.setText(default_url)

    client_app.show()
    _logger.info("Window shown, entering event loop")

    # Run event loop
    try:
        result = app.exec()
        _logger.info("Event loop exited with code %d", result)
    except Exception:
        _logger.exception("Exception in event loop")
        raise
    finally:
        _logger.info("Running cleanup")
        client_app.cleanup()
        _logger.info("Cleanup complete")

    return result


if __name__ == "__main__":
    sys.exit(main())
