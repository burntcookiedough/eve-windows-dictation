"""Push-to-talk button widget."""

from enum import Enum, auto

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QPushButton


class InputMode(Enum):
    """Active input mode for PTT."""

    NONE = auto()
    MOUSE = auto()
    KEYBOARD = auto()


class PTTButton(QPushButton):
    """Large push-to-talk button with visual feedback.

    Press and hold to record, release to stop.
    Supports both mouse click and F17 key, mutually exclusive.
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
        self._input_mode = InputMode.NONE

    def mousePressEvent(self, event) -> None:
        super().mousePressEvent(event)
        # Only activate if no input mode is active
        if self._input_mode == InputMode.NONE:
            self._input_mode = InputMode.MOUSE
            self._activate()

    def mouseReleaseEvent(self, event) -> None:
        super().mouseReleaseEvent(event)
        # Only deactivate if mouse started the recording
        if self._input_mode == InputMode.MOUSE:
            self._deactivate()
            self._input_mode = InputMode.NONE

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

    def key_activate(self) -> None:
        """Activate via keyboard (F17). Only works if not already active via mouse."""
        if self._input_mode == InputMode.NONE:
            self._input_mode = InputMode.KEYBOARD
            self._activate()

    def key_deactivate(self) -> None:
        """Deactivate via keyboard (F17). Only works if activated via keyboard."""
        if self._input_mode == InputMode.KEYBOARD:
            self._deactivate()
            self._input_mode = InputMode.NONE
