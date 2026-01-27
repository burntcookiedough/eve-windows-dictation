"""Entry point for the test client."""

import argparse
import logging
import sys
import threading

from PySide6.QtWidgets import QApplication

from .app import TestClientApp, setup_dark_theme


class FlushingStreamHandler(logging.StreamHandler):
    """StreamHandler that flushes after every emit."""

    def emit(self, record):
        super().emit(record)
        self.flush()


def setup_logging(verbose: bool = False) -> None:
    """Configure logging to console."""
    level = logging.DEBUG if verbose else logging.INFO

    handler = FlushingStreamHandler(sys.stdout)
    handler.setLevel(level)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        )
    )

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()
    root.addHandler(handler)

    # Reduce noise from websockets library (logs every binary frame at DEBUG)
    logging.getLogger("websockets").setLevel(logging.INFO)


def setup_exception_hooks() -> None:
    """Set up global exception hooks."""

    def handle_exception(exc_type, exc_value, exc_tb):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_tb)
            return
        logging.critical("Uncaught exception", exc_info=(exc_type, exc_value, exc_tb))

    def handle_thread_exception(args):
        logging.critical(
            "Uncaught exception in thread %s",
            args.thread.name if args.thread else "unknown",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    sys.excepthook = handle_exception
    threading.excepthook = handle_thread_exception


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Voice Transcription Test Client",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose (debug) logging",
    )
    return parser.parse_args()


def main() -> int:
    """Run the test client application."""
    args = parse_args()

    setup_logging(verbose=args.verbose)
    setup_exception_hooks()

    logging.info("Starting Voice Transcription Test Client")

    app = QApplication(sys.argv)
    app.setApplicationName("Voice Transcription Test Client")

    setup_dark_theme(app)

    client_app = TestClientApp()
    client_app.show()

    try:
        result = app.exec()
    finally:
        client_app.cleanup()

    return result


if __name__ == "__main__":
    sys.exit(main())
