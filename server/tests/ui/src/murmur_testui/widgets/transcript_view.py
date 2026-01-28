"""Transcript display widget."""

from datetime import datetime

from PySide6.QtCore import Qt
from PySide6.QtGui import QTextCursor
from PySide6.QtWidgets import QTextEdit


class TranscriptView(QTextEdit):
    """Scrolling transcript display with styled text.

    Shows partial results in gray italic, final results in white bold,
    and system messages in blue.
    """

    STYLE = """
        QTextEdit {
            background-color: #1b1b1b;
            color: #e0e1dd;
            border: 1px solid #3d3d3d;
            border-radius: 4px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 14px;
            padding: 8px;
        }
    """

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setReadOnly(True)
        self.setStyleSheet(self.STYLE)
        self._last_partial_block = None

    def _timestamp(self) -> str:
        """Get current timestamp string."""
        return datetime.now().strftime("%H:%M:%S")

    def _append_html(self, html: str, replace_partial: bool = False) -> None:
        """Append HTML to the display."""
        cursor = self.textCursor()

        # If replacing partial, remove the last partial block
        if replace_partial and self._last_partial_block is not None:
            cursor.setPosition(self._last_partial_block)
            cursor.movePosition(QTextCursor.MoveOperation.End, QTextCursor.MoveMode.KeepAnchor)
            cursor.removeSelectedText()

        # Move to end and append
        cursor.movePosition(QTextCursor.MoveOperation.End)
        cursor.insertHtml(html + "<br>")

        # Scroll to bottom
        self.verticalScrollBar().setValue(self.verticalScrollBar().maximum())

    def add_partial(
        self,
        text: str,
        confidence: float,
        transcription_time: float,
        audio_duration: float,
    ) -> None:
        """Add or update partial transcription result."""
        # Remember position before inserting partial
        cursor = self.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        self._last_partial_block = cursor.position()

        conf_pct = int(confidence * 100)
        # Calculate speed ratio (avoid division by zero)
        speed_ratio = int(audio_duration / transcription_time) if transcription_time > 0 else 0
        html = (
            f'<span style="color: #888888; font-style: italic;">'
            f'[{self._timestamp()}] ({conf_pct}%) ({speed_ratio}x) {transcription_time:.3f}s {text}</span>'
        )
        self._append_html(html, replace_partial=False)

    def add_final(
        self,
        text: str,
        confidence: float,
        transcription_time: float,
        audio_duration: float,
    ) -> None:
        """Add final transcription result."""
        # Clear last partial since we're replacing with final
        self._last_partial_block = None

        conf_pct = int(confidence * 100)
        # Calculate speed ratio (avoid division by zero)
        speed_ratio = int(audio_duration / transcription_time) if transcription_time > 0 else 0
        html = (
            f'<span style="color: #ffffff; font-weight: bold;">'
            f'[{self._timestamp()}] ({conf_pct}%) ({speed_ratio}x) {transcription_time:.3f}s {text}</span>'
        )
        self._append_html(html, replace_partial=True)

    def add_system(self, message: str) -> None:
        """Add system message."""
        self._last_partial_block = None
        html = (
            f'<span style="color: #64b5f6;">'
            f'[{self._timestamp()}] {message}</span>'
        )
        self._append_html(html)

    def add_error(self, message: str) -> None:
        """Add error message."""
        self._last_partial_block = None
        html = (
            f'<span style="color: #ef5350; font-weight: bold;">'
            f'[{self._timestamp()}] ERROR: {message}</span>'
        )
        self._append_html(html)

    def clear_transcript(self) -> None:
        """Clear all transcript content."""
        self._last_partial_block = None
        self.clear()
