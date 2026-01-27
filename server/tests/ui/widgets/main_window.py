"""Main window for the test client."""

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QKeyEvent
from PySide6.QtWidgets import (
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from tests.ui.widgets.ptt_button import PTTButton
from tests.ui.widgets.transcript_view import TranscriptView


class MainWindow(QMainWindow):
    """Main window with dark theme for the voice transcription test client."""

    # Signals
    connect_clicked = Signal(str)  # URL
    disconnect_clicked = Signal()
    ptt_pressed = Signal()
    ptt_released = Signal()
    log_toggled = Signal(bool)

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

        # Server connection bar
        conn_layout = QHBoxLayout()
        conn_layout.addWidget(QLabel("Server:"))

        self.url_input = QLineEdit("ws://localhost:9867/ws")
        self.url_input.setMinimumWidth(300)
        conn_layout.addWidget(self.url_input, stretch=1)

        self.connect_btn = QPushButton("Connect")
        self.connect_btn.setFixedWidth(100)
        conn_layout.addWidget(self.connect_btn)

        layout.addLayout(conn_layout)

        # Transcript area
        self.transcript = TranscriptView()
        layout.addWidget(self.transcript, stretch=1)

        # PTT button
        self.ptt_btn = PTTButton()
        self.ptt_btn.setEnabled(False)
        layout.addWidget(self.ptt_btn)

        # Hint text
        hint = QLabel("Hold Space or click button to record")
        hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hint.setStyleSheet("color: #888888; font-size: 12px;")
        layout.addWidget(hint)

        # Status bar
        status_layout = QHBoxLayout()

        self.status_label = QLabel("Status: Disconnected")
        self.status_label.setStyleSheet("color: #888888;")
        status_layout.addWidget(self.status_label, stretch=1)

        self.log_checkbox = QCheckBox("Log to file")
        status_layout.addWidget(self.log_checkbox)

        layout.addLayout(status_layout)

    def _connect_signals(self) -> None:
        """Connect internal signals."""
        self.connect_btn.clicked.connect(self._on_connect_clicked)
        self.ptt_btn.pressed_ptt.connect(self.ptt_pressed.emit)
        self.ptt_btn.released_ptt.connect(self.ptt_released.emit)
        self.log_checkbox.toggled.connect(self.log_toggled.emit)

    def _on_connect_clicked(self) -> None:
        """Handle connect button click."""
        if self.connect_btn.text() == "Connect":
            self.connect_clicked.emit(self.url_input.text())
        else:
            self.disconnect_clicked.emit()

    def keyPressEvent(self, event: QKeyEvent) -> None:
        """Handle key press for PTT."""
        if event.key() == Qt.Key.Key_Space and not event.isAutoRepeat():
            if self.ptt_btn.isEnabled() and not self.ptt_btn.is_active:
                self.ptt_btn._activate()
        else:
            super().keyPressEvent(event)

    def keyReleaseEvent(self, event: QKeyEvent) -> None:
        """Handle key release for PTT."""
        if event.key() == Qt.Key.Key_Space and not event.isAutoRepeat():
            if self.ptt_btn.isEnabled() and self.ptt_btn.is_active:
                self.ptt_btn._deactivate()
        else:
            super().keyReleaseEvent(event)

    # Public methods for state updates

    def set_connected(self, connected: bool) -> None:
        """Update UI for connection state."""
        if connected:
            self.connect_btn.setText("Disconnect")
            self.status_label.setText("Status: Connected")
            self.status_label.setStyleSheet("color: #4caf50;")
            self.url_input.setEnabled(False)
            self.ptt_btn.setEnabled(True)
        else:
            self.connect_btn.setText("Connect")
            self.status_label.setText("Status: Disconnected")
            self.status_label.setStyleSheet("color: #888888;")
            self.url_input.setEnabled(True)
            self.ptt_btn.setEnabled(False)

    def set_status(self, text: str, error: bool = False) -> None:
        """Set status bar text."""
        self.status_label.setText(f"Status: {text}")
        if error:
            self.status_label.setStyleSheet("color: #ef5350;")
        else:
            self.status_label.setStyleSheet("color: #4caf50;")
