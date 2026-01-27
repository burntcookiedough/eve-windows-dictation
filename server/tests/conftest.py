"""Pytest configuration and fixtures."""

import pytest


@pytest.fixture
def sample_start_frame() -> dict:
    """Sample start frame data."""
    return {
        "frame": "control",
        "type": "start",
        "silence_timeout": 5.0,
    }


@pytest.fixture
def sample_stop_frame() -> dict:
    """Sample stop frame data."""
    return {
        "frame": "control",
        "type": "stop",
    }
