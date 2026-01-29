"""Global hotkey listener for F17 key."""

import logging
import threading
from typing import Callable

from pynput import keyboard

logger = logging.getLogger("murmur_testui.global_hotkey")


class GlobalHotkeyListener:
    """Listens for F17 key globally (even when window not focused).

    Uses pynput to monitor keyboard events system-wide.
    """

    def __init__(
        self,
        on_press: Callable[[], None],
        on_release: Callable[[], None],
    ) -> None:
        self._on_press = on_press
        self._on_release = on_release
        self._listener: keyboard.Listener | None = None
        self._is_pressed = False
        self._lock = threading.Lock()

    def start(self) -> None:
        """Start listening for global F17 events."""
        if self._listener is not None:
            return

        logger.debug("Starting global hotkey listener")
        self._listener = keyboard.Listener(
            on_press=self._handle_press,
            on_release=self._handle_release,
        )
        self._listener.start()

    def stop(self) -> None:
        """Stop listening for global F17 events."""
        if self._listener is None:
            return

        logger.debug("Stopping global hotkey listener")
        self._listener.stop()
        self._listener = None

        # Reset state
        with self._lock:
            self._is_pressed = False

    @property
    def is_running(self) -> bool:
        """Whether the listener is currently running."""
        return self._listener is not None and self._listener.running

    def _handle_press(self, key: keyboard.Key | keyboard.KeyCode | None) -> None:
        """Handle key press event."""
        if not self._is_f17(key):
            return

        with self._lock:
            if self._is_pressed:
                # Ignore auto-repeat
                return
            self._is_pressed = True

        logger.debug("Global F17 pressed")
        try:
            self._on_press()
        except Exception:
            logger.exception("Error in F17 press callback")

    def _handle_release(self, key: keyboard.Key | keyboard.KeyCode | None) -> None:
        """Handle key release event."""
        if not self._is_f17(key):
            return

        with self._lock:
            if not self._is_pressed:
                return
            self._is_pressed = False

        logger.debug("Global F17 released")
        try:
            self._on_release()
        except Exception:
            logger.exception("Error in F17 release callback")

    def _is_f17(self, key: keyboard.Key | keyboard.KeyCode | None) -> bool:
        """Check if the key is F17."""
        if key is None:
            return False

        # pynput represents F17 as keyboard.Key.f17 on some platforms,
        # or as a KeyCode with vk (virtual key) on others
        if hasattr(keyboard.Key, "f17"):
            if key == keyboard.Key.f17:
                return True

        # Check by virtual key code (F17 = 0x80 = 128 on Windows)
        # On Linux/X11, F17 is typically keycode 187 or keysym 0xFFCE
        if isinstance(key, keyboard.KeyCode):
            # Windows: vk=128 for F17
            if hasattr(key, "vk") and key.vk == 128:
                return True
            # Linux: char might be set, or check by other means
            # F17 keysym is 0xFFCE (65486)
            if hasattr(key, "_symbol") and key._symbol == "F17":
                return True

        return False
