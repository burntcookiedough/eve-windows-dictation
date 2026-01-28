"""Qt application setup and integration."""

import asyncio
import logging
from typing import Callable

from PySide6.QtCore import QObject, QThread, Signal
from PySide6.QtWidgets import QApplication

from .client import (
    VoiceClient,
    MicrophoneCapture,
    ClientEvent,
    ConnectedEvent,
    ReadyEvent,
    PartialEvent,
    FinalEvent,
    ClosingEvent,
    ErrorEvent,
)
from .widgets import MainWindow

logger = logging.getLogger("murmur_testui")


class AudioWorker(QThread):
    """Background thread for audio capture and sending."""

    error_occurred = Signal(str)

    def __init__(self, mic: MicrophoneCapture, send_callback: Callable) -> None:
        super().__init__()
        self._mic = mic
        self._send_callback = send_callback
        self._running = False

    def run(self) -> None:
        """Capture and send audio chunks."""
        logger.debug("AudioWorker starting")
        self._running = True
        try:
            self._mic.start()
        except Exception as e:
            logger.exception("Failed to start microphone")
            self.error_occurred.emit(f"Microphone error: {e}")
            return

        try:
            for chunk in self._mic.chunks():
                if not self._running:
                    break
                try:
                    self._send_callback(chunk)
                except Exception as e:
                    logger.exception("Error sending audio chunk")
                    self.error_occurred.emit(str(e))
                    break
        except Exception as e:
            logger.exception("Error in audio capture loop")
            self.error_occurred.emit(f"Audio error: {e}")
        finally:
            self._mic.stop()
            logger.debug("AudioWorker finished")

    def stop(self) -> None:
        """Stop audio capture."""
        self._running = False
        self._mic.stop()


class AsyncBridge(QObject):
    """Bridge between asyncio and Qt signals."""

    event_received = Signal(object)

    def __init__(self) -> None:
        super().__init__()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: QThread | None = None

    def start(self) -> None:
        """Start the asyncio event loop in a background thread."""
        self._thread = QThread()
        self._thread.run = self._run_loop
        self._thread.start()

    def stop(self) -> None:
        """Stop the asyncio event loop."""
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.wait(5000)
            self._thread = None

    def _run_loop(self) -> None:
        """Run asyncio event loop."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_forever()
        finally:
            self._loop.close()

    def run_coroutine(self, coro) -> asyncio.Future:
        """Schedule a coroutine on the asyncio loop."""
        if self._loop is None:
            raise RuntimeError("Event loop not started")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        future.add_done_callback(self._on_done)
        return future

    def _on_done(self, future: asyncio.Future) -> None:
        """Log exceptions from coroutines."""
        try:
            exc = future.exception()
            if exc:
                logger.error("Coroutine error: %s", exc)
        except (asyncio.CancelledError, asyncio.InvalidStateError):
            pass


class TestClientApp(QObject):
    """Main application controller.

    Simplified flow:
    - PTT press: connect → start session → record audio
    - PTT release: stop audio → stop session → disconnect
    """

    def __init__(self) -> None:
        super().__init__()

        self._client = VoiceClient()
        self._mic = MicrophoneCapture()
        self._window = MainWindow()
        self._async_bridge = AsyncBridge()
        self._audio_worker: AudioWorker | None = None

        self._recording = False

        self._setup()

    def _setup(self) -> None:
        """Set up event handling."""
        self._client.on_event = self._on_client_event
        self._window.ptt_pressed.connect(self._on_ptt_pressed)
        self._window.ptt_released.connect(self._on_ptt_released)
        self._async_bridge.event_received.connect(self._handle_event)
        self._async_bridge.start()

    def _on_client_event(self, event: ClientEvent) -> None:
        """Handle client event (called from asyncio thread)."""
        self._async_bridge.event_received.emit(event)

    def _handle_event(self, event: ClientEvent) -> None:
        """Handle client event in Qt thread."""
        if isinstance(event, ConnectedEvent):
            logger.info("Connected to %s", event.url)

        elif isinstance(event, ReadyEvent):
            self._window.set_status("Recording...")
            self._window.transcript.add_system("Recording started")
            logger.info("Server ready, recording")

        elif isinstance(event, PartialEvent):
            self._window.transcript.add_partial(
                event.text,
                event.confidence,
                event.transcription_time,
                event.audio_duration,
            )

        elif isinstance(event, FinalEvent):
            self._window.transcript.add_final(
                event.text,
                event.confidence,
                event.transcription_time,
                event.audio_duration,
            )
            QApplication.clipboard().setText(event.text)
            logger.info("Final: %s", event.text)

        elif isinstance(event, ClosingEvent):
            self._window.transcript.add_system(f"Session ended: {event.reason}")
            self._window.set_status("Ready")
            logger.info("Session closed: %s", event.reason)

        elif isinstance(event, ErrorEvent):
            self._window.transcript.add_error(f"{event.code}: {event.message}")
            self._window.set_status(event.message, error=True)
            logger.error("Error %s: %s", event.code, event.message)
            # Reset state on error
            self._recording = False
            self._window.set_recording(False)

    def _on_ptt_pressed(self) -> None:
        """Handle PTT button press - start full recording flow."""
        if self._recording:
            return

        self._recording = True
        self._window.set_recording(True)
        self._window.set_status("Connecting...")

        url = self._window.get_url()
        self._async_bridge.run_coroutine(self._start_recording(url))

    async def _start_recording(self, url: str) -> None:
        """Connect, start session, and begin audio capture."""
        try:
            # Connect to server
            logger.debug("Connecting to %s", url)
            await self._client._connect(url)

            # Start transcription session
            logger.debug("Starting session")
            await self._client.start(silence_timeout=30.0)

            # Start audio capture (runs in separate thread)
            self._audio_worker = AudioWorker(
                self._mic,
                lambda chunk: self._async_bridge.run_coroutine(
                    self._client.send_audio(chunk)
                ),
            )
            self._audio_worker.error_occurred.connect(self._on_audio_error)
            self._audio_worker.start()

        except Exception as e:
            logger.exception("Failed to start recording")
            self._async_bridge.event_received.emit(
                ErrorEvent(code="start_failed", message=str(e))
            )

    def _on_audio_error(self, error: str) -> None:
        """Handle audio worker error."""
        self._async_bridge.event_received.emit(
            ErrorEvent(code="audio_error", message=error)
        )

    def _on_ptt_released(self) -> None:
        """Handle PTT button release - stop recording and disconnect."""
        if not self._recording:
            return

        self._recording = False
        self._window.set_recording(False)
        self._window.set_status("Finishing...")

        # Stop audio worker first
        if self._audio_worker:
            self._audio_worker.stop()
            self._audio_worker.wait(3000)
            self._audio_worker = None

        # Stop session and disconnect
        self._async_bridge.run_coroutine(self._stop_recording())

    async def _stop_recording(self) -> None:
        """Stop session and disconnect."""
        try:
            # Send stop and wait for server to send final transcription
            logger.debug("Stopping session")
            await self._client.stop()
        except Exception as e:
            logger.warning("Error stopping session: %s", e)
            # Emit closing event since we won't get one from server
            self._async_bridge.event_received.emit(
                ClosingEvent(reason="stop_failed")
            )

        try:
            # Disconnect (server should have already sent closing frame)
            logger.debug("Disconnecting")
            await self._client._disconnect()
        except Exception as e:
            logger.warning("Error disconnecting: %s", e)

    def show(self) -> None:
        """Show the main window."""
        self._window.show()

    def cleanup(self) -> None:
        """Clean up resources."""
        logger.debug("Cleaning up")

        if self._audio_worker:
            self._audio_worker.stop()
            self._audio_worker.wait(3000)

        if self._recording:
            try:
                self._async_bridge.run_coroutine(self._client._disconnect())
            except Exception:
                pass

        self._async_bridge.stop()
        logger.debug("Cleanup complete")


def setup_dark_theme(app: QApplication) -> None:
    """Apply dark theme to the application."""
    from PySide6.QtGui import QPalette, QColor
    from PySide6.QtWidgets import QStyleFactory

    app.setStyle(QStyleFactory.create("Fusion"))

    palette = QPalette()

    # Base colors
    palette.setColor(QPalette.ColorRole.Window, QColor(30, 30, 30))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(224, 225, 221))
    palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
    palette.setColor(QPalette.ColorRole.AlternateBase, QColor(35, 35, 35))
    palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(224, 225, 221))
    palette.setColor(QPalette.ColorRole.ToolTipText, QColor(224, 225, 221))
    palette.setColor(QPalette.ColorRole.Text, QColor(224, 225, 221))
    palette.setColor(QPalette.ColorRole.Button, QColor(45, 45, 45))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(224, 225, 221))
    palette.setColor(QPalette.ColorRole.BrightText, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.Link, QColor(100, 181, 246))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(61, 90, 128))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor(224, 225, 221))

    # Disabled colors
    palette.setColor(
        QPalette.ColorGroup.Disabled,
        QPalette.ColorRole.WindowText,
        QColor(128, 128, 128),
    )
    palette.setColor(
        QPalette.ColorGroup.Disabled,
        QPalette.ColorRole.Text,
        QColor(128, 128, 128),
    )
    palette.setColor(
        QPalette.ColorGroup.Disabled,
        QPalette.ColorRole.ButtonText,
        QColor(128, 128, 128),
    )

    app.setPalette(palette)
