"""PID file management for server lifecycle coordination with Electron app.

The PID file is stored in the Electron userData directory so both processes
can find it. On Windows this is %LOCALAPPDATA%/murmur/server.pid.
"""

import atexit
import json
import logging
import os
import time
from pathlib import Path
from typing import TypedDict

logger = logging.getLogger(__name__)


class PidFileData(TypedDict):
    """Structure of the PID file JSON."""

    pid: int
    port: int
    startedAt: int  # Unix timestamp in milliseconds


def get_pid_file_path() -> Path:
    """Get the path to the PID file.

    Uses LOCALAPPDATA on Windows (matches Electron's app.getPath('userData')).
    Falls back to ~/.local/share/murmur on Linux.
    """
    if os.name == "nt":
        # Windows: %LOCALAPPDATA%/murmur
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return Path(local_app_data) / "murmur" / "server.pid"
        # Fallback if LOCALAPPDATA not set
        return Path.home() / "AppData" / "Local" / "murmur" / "server.pid"
    else:
        # Linux/macOS: ~/.local/share/murmur or ~/Library/Application Support/murmur
        if os.name == "darwin":
            return Path.home() / "Library" / "Application Support" / "murmur" / "server.pid"
        return Path.home() / ".local" / "share" / "murmur" / "server.pid"


def write_pid_file(pid: int, port: int) -> None:
    """Write the PID file with current process info.

    Args:
        pid: Process ID of the server
        port: Port the server is listening on
    """
    pid_path = get_pid_file_path()

    # Ensure parent directory exists
    pid_path.parent.mkdir(parents=True, exist_ok=True)

    data: PidFileData = {
        "pid": pid,
        "port": port,
        "startedAt": int(time.time() * 1000),  # JavaScript-style timestamp
    }

    try:
        with open(pid_path, "w") as f:
            json.dump(data, f, indent=2)
        logger.info(f"PID file written: {pid_path}")
    except OSError as e:
        logger.error(f"Failed to write PID file: {e}")


def read_pid_file() -> PidFileData | None:
    """Read the PID file if it exists.

    Returns:
        PID file data dict, or None if file doesn't exist or is invalid.
    """
    pid_path = get_pid_file_path()

    if not pid_path.exists():
        return None

    try:
        with open(pid_path) as f:
            data = json.load(f)
        # Validate required fields
        if all(k in data for k in ("pid", "port", "startedAt")):
            return data
        logger.warning("PID file missing required fields")
        return None
    except (OSError, json.JSONDecodeError) as e:
        logger.warning(f"Failed to read PID file: {e}")
        return None


def remove_pid_file() -> None:
    """Remove the PID file if it exists."""
    pid_path = get_pid_file_path()

    try:
        if pid_path.exists():
            pid_path.unlink()
            logger.info(f"PID file removed: {pid_path}")
    except OSError as e:
        logger.warning(f"Failed to remove PID file: {e}")


def register_cleanup() -> None:
    """Register PID file cleanup on process exit."""
    atexit.register(remove_pid_file)
