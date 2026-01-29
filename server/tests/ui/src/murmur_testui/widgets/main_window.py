"""Main window for the test client."""

import logging

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QCloseEvent, QKeyEvent
from PySide6.QtWidgets import (
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QVBoxLayout,
    QWidget,
)

from .ptt_button import PTTButton
from .transcript_view import TranscriptView

logger = logging.getLogger("murmur_testui.window")


class MainWindow(QMainWindow):
    """Main window for the voice transcription test client."""

    # Signals
    ptt_pressed = Signal()
    ptt_released = Signal()
    global_hotkey_toggled = Signal(bool)

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Voice Transcription Test Client")
        self.setMinimumSize(600, 500)

        self._setup_ui()
        self._connect_signals()

    def _setup_ui(self) -> None:
        """Set up the UI layout."""
        central = QWidget()
        self.setCentralWidget(central)

        layout = QVBoxLayout(central)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        # Server URL bar
        url_layout = QHBoxLayout()
        url_layout.addWidget(QLabel("Server:"))

        # Use 127.0.0.1 instead of localhost to avoid DNS resolution delay
        self.url_input = QLineEdit("ws://127.0.0.1:51717/transcribe")
        self.url_input.setMinimumWidth(300)
        url_layout.addWidget(self.url_input, stretch=1)

        layout.addLayout(url_layout)

        # Transcript area
        self.transcript = TranscriptView()
        layout.addWidget(self.transcript, stretch=1)

        # PTT button (always enabled)
        self.ptt_btn = PTTButton()
        layout.addWidget(self.ptt_btn)

        # Global hotkey toggle
        self.global_hotkey_checkbox = QCheckBox("Global F17 hotkey (works without focus)")
        self.global_hotkey_checkbox.setStyleSheet("color: #888888; font-size: 12px;")
        self.global_hotkey_checkbox.setToolTip(
            "When enabled, F17 works even when this window is not focused.\n"
            "The window will appear on top when recording."
        )
        layout.addWidget(self.global_hotkey_checkbox)

        # Hint text
        hint = QLabel("Hold button or F17 to record - connects automatically")
        hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hint.setStyleSheet("color: #888888; font-size: 12px;")
        layout.addWidget(hint)

        # Status bar
        self.status_label = QLabel("Ready")
        self.status_label.setStyleSheet("color: #888888;")
        layout.addWidget(self.status_label)

    def _connect_signals(self) -> None:
        """Connect internal signals."""
        self.ptt_btn.pressed_ptt.connect(self.ptt_pressed.emit)
        self.ptt_btn.released_ptt.connect(self.ptt_released.emit)
        self.global_hotkey_checkbox.toggled.connect(self.global_hotkey_toggled.emit)

    def get_url(self) -> str:
        """Get the current server URL."""
        return self.url_input.text()

    def set_status(self, text: str, error: bool = False) -> None:
        """Set status bar text."""
        self.status_label.setText(text)
        if error:
            self.status_label.setStyleSheet("color: #ef5350;")
        else:
            self.status_label.setStyleSheet("color: #888888;")

    def set_recording(self, recording: bool) -> None:
        """Update UI for recording state."""
        self.url_input.setEnabled(not recording)

    def keyPressEvent(self, event: QKeyEvent) -> None:
        """Handle key press events."""
        # Ignore auto-repeat
        if event.isAutoRepeat():
            return

        # F17 activates PTT via keyboard
        if event.key() == Qt.Key.Key_F17:
            self.ptt_btn.key_activate()
            return

        super().keyPressEvent(event)

    def keyReleaseEvent(self, event: QKeyEvent) -> None:
        """Handle key release events."""
        # Ignore auto-repeat
        if event.isAutoRepeat():
            return

        # F17 deactivates PTT via keyboard
        if event.key() == Qt.Key.Key_F17:
            self.ptt_btn.key_deactivate()
            return

        super().keyReleaseEvent(event)

    def raise_without_focus(self) -> None:
        """Raise window to top without stealing keyboard focus.

        This brings the window visually on top of other windows while
        keeping the keyboard focus on whatever application the user
        was using. Useful for global hotkey activation.
        """
        # Ensure window is visible and not minimized
        if self.isMinimized():
            self.showNormal()

        # Set stay-on-top hint temporarily to ensure we're on top
        original_flags = self.windowFlags()
        self.setWindowFlags(original_flags | Qt.WindowType.WindowStaysOnTopHint)
        self.show()

        # Remove stay-on-top after a brief moment so other windows can go on top later
        from PySide6.QtCore import QTimer

        QTimer.singleShot(100, lambda: self._restore_window_flags(original_flags))

    def _restore_window_flags(self, flags: Qt.WindowType) -> None:
        """Restore original window flags."""
        self.setWindowFlags(flags)
        self.show()

    def closeEvent(self, event: QCloseEvent) -> None:
        """Handle window close event."""
        logger.debug("Window closing")
        super().closeEvent(event)
