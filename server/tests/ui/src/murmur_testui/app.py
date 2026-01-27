"""Qt application setup and integration."""

import asyncio
import logging
from datetime import datetime
from pathlib import Path
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
        self._running = True
        self._mic.start()

        try:
            for chunk in self._mic.chunks():
                if not self._running:
                    break
                try:
                    self._send_callback(chunk)
                except Exception as e:
                    self.error_occurred.emit(str(e))
                    break
        finally:
            self._mic.stop()

    def stop(self) -> None:
        """Stop audio capture."""
        self._running = False
        self._mic.stop()


class AsyncBridge(QObject):
    """Bridge between asyncio and Qt signals."""

    event_received = Signal(object)  # ClientEvent

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
            self._thread.wait()
            self._thread = None

    def _run_loop(self) -> None:
        """Run asyncio event loop."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()
        self._loop.close()

    def run_coroutine(self, coro) -> asyncio.Future:
        """Schedule a coroutine on the asyncio loop."""
        if self._loop is None:
            raise RuntimeError("Event loop not started")
        return asyncio.run_coroutine_threadsafe(coro, self._loop)


class TestClientApp(QObject):
    """Main application controller."""

    def __init__(self, log_file: Path | None = None) -> None:
        super().__init__()

        self._log_file = log_file
        self._log_handle = None
        self._logging_enabled = False

        # Create components
        self._client = VoiceClient()
        self._mic = MicrophoneCapture()
        self._window = MainWindow()
        self._async_bridge = AsyncBridge()
        self._audio_worker: AudioWorker | None = None

        self._connected = False
        self._url = ""

        self._setup()

    def _setup(self) -> None:
        """Set up event handling."""
        # Client events
        self._client.on_event = self._on_client_event

        # Window signals
        self._window.connect_clicked.connect(self._on_connect)
        self._window.disconnect_clicked.connect(self._on_disconnect)
        self._window.ptt_pressed.connect(self._on_ptt_pressed)
        self._window.ptt_released.connect(self._on_ptt_released)
        self._window.log_toggled.connect(self._on_log_toggled)

        # Async bridge
        self._async_bridge.event_received.connect(self._handle_event)
        self._async_bridge.start()

    def _on_client_event(self, event: ClientEvent) -> None:
        """Handle client event (called from asyncio thread)."""
        # Emit signal to handle in Qt thread
        self._async_bridge.event_received.emit(event)

    def _handle_event(self, event: ClientEvent) -> None:
        """Handle client event in Qt thread."""
        if isinstance(event, ConnectedEvent):
            self._connected = True
            self._window.set_connected(True)
            self._window.transcript.add_system(f"Connected to {event.url}")
            self._log(f"Connected to {event.url}")

        elif isinstance(event, ReadyEvent):
            self._window.transcript.add_system("Server ready, listening...")
            self._log("Server ready")

        elif isinstance(event, PartialEvent):
            self._window.transcript.add_partial(event.text, event.confidence)
            self._log(f"Partial ({event.confidence:.0%}): {event.text}")

        elif isinstance(event, FinalEvent):
            self._window.transcript.add_final(event.text, event.confidence)
            self._log(f"Final ({event.confidence:.0%}): {event.text}")

        elif isinstance(event, ClosingEvent):
            self._window.transcript.add_system(f"Session closed: {event.reason}")
            self._log(f"Session closed: {event.reason}")

        elif isinstance(event, ErrorEvent):
            self._window.transcript.add_error(f"{event.code}: {event.message}")
            self._window.set_status(event.message, error=True)
            self._log(f"Error {event.code}: {event.message}")

    def _on_connect(self, url: str) -> None:
        """Handle connect button click."""
        self._url = url
        self._window.set_status("Connecting...")
        self._async_bridge.run_coroutine(self._connect(url))

    async def _connect(self, url: str) -> None:
        """Connect to the server."""
        try:
            await self._client._connect(url)
        except Exception as e:
            self._async_bridge.event_received.emit(
                ErrorEvent(code="connection_failed", message=str(e))
            )

    def _on_disconnect(self) -> None:
        """Handle disconnect button click."""
        self._async_bridge.run_coroutine(self._disconnect())

    async def _disconnect(self) -> None:
        """Disconnect from the server."""
        try:
            await self._client._disconnect()
        except Exception:
            pass
        finally:
            self._connected = False
            self._async_bridge.event_received.emit(
                ClosingEvent(reason="user_disconnect")
            )
            # Update UI in Qt thread
            from PySide6.QtCore import QMetaObject, Qt, Q_ARG

            QMetaObject.invokeMethod(
                self._window,
                "set_connected",
                Qt.ConnectionType.QueuedConnection,
                Q_ARG(bool, False),
            )

    def _on_ptt_pressed(self) -> None:
        """Handle PTT button press."""
        if not self._connected:
            return

        self._window.transcript.add_system("Recording started")
        self._log("Recording started")

        # Start session
        self._async_bridge.run_coroutine(self._start_session())

    async def _start_session(self) -> None:
        """Start transcription session and audio capture."""
        try:
            await self._client.start(silence_timeout=5.0)

            # Start audio worker
            self._audio_worker = AudioWorker(
                self._mic,
                lambda chunk: self._async_bridge.run_coroutine(
                    self._client.send_audio(chunk)
                ),
            )
            self._audio_worker.error_occurred.connect(
                lambda e: self._window.transcript.add_error(e)
            )
            self._audio_worker.start()

        except Exception as e:
            self._async_bridge.event_received.emit(
                ErrorEvent(code="start_failed", message=str(e))
            )

    def _on_ptt_released(self) -> None:
        """Handle PTT button release."""
        if not self._connected:
            return

        self._window.transcript.add_system("Recording stopped")
        self._log("Recording stopped")

        # Stop audio worker
        if self._audio_worker:
            self._audio_worker.stop()
            self._audio_worker.wait()
            self._audio_worker = None

        # Stop session
        self._async_bridge.run_coroutine(self._stop_session())

    async def _stop_session(self) -> None:
        """Stop transcription session."""
        try:
            await self._client.stop()
        except Exception as e:
            self._async_bridge.event_received.emit(
                ErrorEvent(code="stop_failed", message=str(e))
            )

    def _on_log_toggled(self, enabled: bool) -> None:
        """Handle log checkbox toggle."""
        self._logging_enabled = enabled

        if enabled and self._log_file:
            try:
                self._log_handle = open(self._log_file, "a")
                self._log("Logging started")
            except Exception as e:
                self._window.transcript.add_error(f"Failed to open log: {e}")
                self._logging_enabled = False
        elif self._log_handle:
            self._log("Logging stopped")
            self._log_handle.close()
            self._log_handle = None

    def _log(self, message: str) -> None:
        """Write to log file if enabled."""
        if self._logging_enabled and self._log_handle:
            timestamp = datetime.now().isoformat()
            self._log_handle.write(f"[{timestamp}] {message}\n")
            self._log_handle.flush()

    def show(self) -> None:
        """Show the main window."""
        self._window.show()

    def cleanup(self) -> None:
        """Clean up resources."""
        if self._audio_worker:
            self._audio_worker.stop()
            self._audio_worker.wait()

        if self._connected:
            self._async_bridge.run_coroutine(self._client._disconnect())

        self._async_bridge.stop()

        if self._log_handle:
            self._log_handle.close()


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
        QPalette.ColorGroup.Disabled, QPalette.ColorRole.Text, QColor(128, 128, 128)
    )
    palette.setColor(
        QPalette.ColorGroup.Disabled,
        QPalette.ColorRole.ButtonText,
        QColor(128, 128, 128),
    )

    app.setPalette(palette)
