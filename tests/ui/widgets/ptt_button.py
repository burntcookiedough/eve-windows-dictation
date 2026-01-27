"""Push-to-talk button widget."""

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QPushButton


class PTTButton(QPushButton):
    """Large push-to-talk button with visual feedback.

    Press and hold to record, release to stop.
    """

    pressed_ptt = Signal()
    released_ptt = Signal()

    # Style constants
    STYLE_INACTIVE = """
        QPushButton {
            background-color: #3d5a80;
            color: #e0e1dd;
            border: 2px solid #5a7a9e;
            border-radius: 8px;
            font-size: 16px;
            font-weight: bold;
            padding: 20px;
            min-height: 60px;
        }
        QPushButton:hover {
            background-color: #4a6fa5;
            border-color: #7a9abe;
        }
    """

    STYLE_ACTIVE = """
        QPushButton {
            background-color: #ee6c4d;
            color: #ffffff;
            border: 2px solid #ff8a6d;
            border-radius: 8px;
            font-size: 16px;
            font-weight: bold;
            padding: 20px;
            min-height: 60px;
        }
    """

    def __init__(self, parent=None) -> None:
        super().__init__("PUSH TO TALK", parent)
        self.setStyleSheet(self.STYLE_INACTIVE)
        self._is_active = False

    def mousePressEvent(self, event) -> None:
        super().mousePressEvent(event)
        self._activate()

    def mouseReleaseEvent(self, event) -> None:
        super().mouseReleaseEvent(event)
        self._deactivate()

    def keyPressEvent(self, event) -> None:
        # Ignore auto-repeat
        if event.isAutoRepeat():
            return
        super().keyPressEvent(event)

    def keyReleaseEvent(self, event) -> None:
        # Ignore auto-repeat
        if event.isAutoRepeat():
            return
        super().keyReleaseEvent(event)

    def _activate(self) -> None:
        """Activate recording state."""
        if not self._is_active:
            self._is_active = True
            self.setText("RECORDING...")
            self.setStyleSheet(self.STYLE_ACTIVE)
            self.pressed_ptt.emit()

    def _deactivate(self) -> None:
        """Deactivate recording state."""
        if self._is_active:
            self._is_active = False
            self.setText("PUSH TO TALK")
            self.setStyleSheet(self.STYLE_INACTIVE)
            self.released_ptt.emit()

    @property
    def is_active(self) -> bool:
        """Whether the button is currently held."""
        return self._is_active
