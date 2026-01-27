"""End-to-end integration tests using test audio file."""

import asyncio
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np
import pytest

from tests.ui.client import VoiceClient, FinalEvent, ClosingEvent, ErrorEvent
from tests.ui.client.audio import load_wav_file, resample_audio, SAMPLE_RATE

# Path to test audio file
TEST_AUDIO_PATH = Path(__file__).parent / "ui" / "test_audio.wav"
TEST_AUDIO_TRANSCRIPT_PATH = TEST_AUDIO_PATH.with_suffix(".txt")

# Server startup settings
SERVER_HOST = "localhost"
SERVER_PORT = 9867
SERVER_STARTUP_TIMEOUT = 30  # seconds


def get_expected_transcript() -> str | None:
    """Get expected transcript from WAV comment or companion .txt file."""
    # Try companion .txt file first
    if TEST_AUDIO_TRANSCRIPT_PATH.exists():
        return TEST_AUDIO_TRANSCRIPT_PATH.read_text().strip()

    # Try WAV COMMENT metadata
    try:
        import mutagen
        from mutagen.wave import WAVE

        audio = WAVE(str(TEST_AUDIO_PATH))
        if audio.tags and "COMM" in audio.tags:
            return str(audio.tags["COMM"])
    except ImportError:
        pass  # mutagen not available

    # Try reading RIFF INFO chunk
    try:
        with open(TEST_AUDIO_PATH, "rb") as f:
            # Simple RIFF/INFO parser for ICMT (comment) tag
            data = f.read()
            if b"ICMT" in data:
                idx = data.index(b"ICMT")
                size = int.from_bytes(data[idx + 4 : idx + 8], "little")
                comment = data[idx + 8 : idx + 8 + size].decode("utf-8", errors="ignore")
                return comment.rstrip("\x00").strip()
    except Exception:
        pass

    return None


def fuzzy_match(actual: str, expected: str, threshold: float = 0.7) -> bool:
    """Check if actual transcript fuzzy-matches expected.

    Uses simple word overlap ratio.
    """
    if not actual or not expected:
        return False

    actual_words = set(actual.lower().split())
    expected_words = set(expected.lower().split())

    if not expected_words:
        return True

    overlap = len(actual_words & expected_words)
    ratio = overlap / len(expected_words)

    return ratio >= threshold


@pytest.fixture(scope="module")
def server_process():
    """Start the voiceserver as a subprocess."""
    # Check if test audio exists
    if not TEST_AUDIO_PATH.exists():
        pytest.skip(f"Test audio not found: {TEST_AUDIO_PATH}")

    # Start server
    proc = subprocess.Popen(
        [sys.executable, "-m", "voiceserver", "--port", str(SERVER_PORT)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    # Wait for server to be ready
    start_time = time.time()
    while time.time() - start_time < SERVER_STARTUP_TIMEOUT:
        try:
            import socket

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            result = sock.connect_ex((SERVER_HOST, SERVER_PORT))
            sock.close()
            if result == 0:
                break
        except Exception:
            pass
        time.sleep(0.5)
    else:
        proc.terminate()
        pytest.fail(f"Server failed to start within {SERVER_STARTUP_TIMEOUT}s")

    yield proc

    # Cleanup
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture
def test_audio() -> tuple[np.ndarray, str | None]:
    """Load test audio file and expected transcript."""
    if not TEST_AUDIO_PATH.exists():
        pytest.skip(f"Test audio not found: {TEST_AUDIO_PATH}")

    samples, sample_rate = load_wav_file(str(TEST_AUDIO_PATH))

    # Resample if needed
    if sample_rate != SAMPLE_RATE:
        samples = resample_audio(samples, sample_rate, SAMPLE_RATE)

    expected = get_expected_transcript()

    return samples, expected


@pytest.mark.integration
@pytest.mark.asyncio
async def test_transcription_with_test_audio(server_process, test_audio):
    """Test transcription using the test audio file."""
    samples, expected_transcript = test_audio

    # Collect events
    events = []
    finals = []

    def on_event(event):
        events.append(event)
        if isinstance(event, FinalEvent):
            finals.append(event.text)

    # Connect and transcribe
    client = VoiceClient()
    client.on_event = on_event

    url = f"ws://{SERVER_HOST}:{SERVER_PORT}/ws"

    async with client.connect(url):
        await client.start(silence_timeout=5.0)

        # Send audio in chunks (20ms = 320 samples)
        chunk_size = 320
        for i in range(0, len(samples), chunk_size):
            chunk = samples[i : i + chunk_size]
            await client.send_audio(chunk)
            # Pace sending to simulate real-time
            await asyncio.sleep(0.02)

        await client.stop()

        # Wait for final transcription
        await asyncio.sleep(2.0)

    # Verify we got results
    assert len(events) > 0, "No events received"

    # Check for errors
    errors = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(errors) == 0, f"Errors received: {errors}"

    # Check we got final transcripts
    assert len(finals) > 0, "No final transcripts received"

    # Combine all final transcripts
    full_transcript = " ".join(finals)
    print(f"Received transcript: {full_transcript}")

    # If we have expected transcript, verify match
    if expected_transcript:
        print(f"Expected transcript: {expected_transcript}")
        assert fuzzy_match(full_transcript, expected_transcript), (
            f"Transcript mismatch.\n"
            f"Expected: {expected_transcript}\n"
            f"Actual: {full_transcript}"
        )


@pytest.mark.integration
@pytest.mark.asyncio
async def test_connection_and_session_lifecycle(server_process):
    """Test basic connection and session lifecycle."""
    events = []

    client = VoiceClient()
    client.on_event = events.append

    url = f"ws://{SERVER_HOST}:{SERVER_PORT}/ws"

    async with client.connect(url):
        # Should receive connected event
        await asyncio.sleep(0.1)
        assert any(e.__class__.__name__ == "ConnectedEvent" for e in events)

        # Start session
        await client.start(silence_timeout=2.0)

        # Should receive ready event
        await asyncio.sleep(0.1)
        assert any(e.__class__.__name__ == "ReadyEvent" for e in events)

        # Stop session
        await client.stop()

        # Should receive closing event
        await asyncio.sleep(0.5)
        assert any(isinstance(e, ClosingEvent) for e in events)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_silence_timeout(server_process):
    """Test that silence timeout triggers closing."""
    events = []

    client = VoiceClient()
    client.on_event = events.append

    url = f"ws://{SERVER_HOST}:{SERVER_PORT}/ws"

    async with client.connect(url):
        await client.start(silence_timeout=1.0)

        # Send a little silence (zeros) then wait
        silence = np.zeros(320, dtype=np.int16)
        for _ in range(10):
            await client.send_audio(silence)
            await asyncio.sleep(0.02)

        # Wait for timeout
        await asyncio.sleep(2.0)

        # Should have received closing due to silence
        closing_events = [e for e in events if isinstance(e, ClosingEvent)]
        assert len(closing_events) > 0
        assert closing_events[0].reason == "silence_timeout"
