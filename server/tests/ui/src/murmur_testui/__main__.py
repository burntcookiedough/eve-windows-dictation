"""Entry point for the test client."""

import argparse
import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication

from .app import TestClientApp, setup_dark_theme


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
    return parser.parse_args()


def main() -> int:
    """Run the test client application."""
    args = parse_args()

    # Build default URL from host/port
    default_url = f"ws://{args.host}:{args.port}/transcribe"

    # Create Qt application
    app = QApplication(sys.argv)
    app.setApplicationName("Voice Transcription Test Client")

    # Apply dark theme
    setup_dark_theme(app)

    # Create and show main app
    client_app = TestClientApp(log_file=args.log_file)

    # Set default URL from args
    client_app._window.url_input.setText(default_url)

    client_app.show()

    # Run event loop
    try:
        result = app.exec()
    finally:
        client_app.cleanup()

    return result


if __name__ == "__main__":
    sys.exit(main())
