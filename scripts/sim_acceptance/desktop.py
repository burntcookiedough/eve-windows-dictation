"""Disposable Windows editor and key observer. Run only on GitHub-hosted Windows."""
from __future__ import annotations

import ctypes
import json
import os
import queue
import sys
import threading
import time
import tkinter as tk
from ctypes import wintypes

SEED = "EVE QA CLIPBOARD SEED"
VKEYS = {"quick": 0x78, "long": 0x79}


class KeyInput(ctypes.Structure):
    _fields_ = [
        ("vk", wintypes.WORD), ("scan", wintypes.WORD), ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD), ("extra", ctypes.c_size_t),
    ]


class MouseInput(ctypes.Structure):
    _fields_ = [
        ("x", wintypes.LONG), ("y", wintypes.LONG), ("data", wintypes.DWORD),
        ("flags", wintypes.DWORD), ("time", wintypes.DWORD), ("extra", ctypes.c_size_t),
    ]


class InputData(ctypes.Union):
    _fields_ = [("key", KeyInput), ("mouse", MouseInput)]


class Input(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("data", InputData)]


class Desktop:
    def __init__(self):
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.user32.GetForegroundWindow.restype = wintypes.HWND
        self.user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        self.user32.GetAncestor.restype = wintypes.HWND
        self.user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        self.user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
        self.user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(Input), ctypes.c_int]
        self.root = tk.Tk()
        self.root.withdraw()
        self.new_window()
        self.root.bind_all("<F9>", lambda event: self.key("quick"))
        self.root.bind_all("<F10>", lambda event: self.key("long"))
        self.events = []
        self.keys = []
        self.queue = queue.Queue()
        self.root.after(5, self.tick)
        threading.Thread(target=self.read_commands, daemon=True).start()

    def new_window(self):
        self.window = tk.Toplevel(self.root)
        self.window.title("Eve simulated acceptance editor")
        self.window.geometry("640x260+40+60")
        self.editor = tk.Text(self.window, undo=False)
        self.editor.pack(expand=True, fill="both")
        self.editor.bind("<<Modified>>", self.modified)

    def read_commands(self):
        for line in sys.stdin:
            self.queue.put(json.loads(line))
        self.queue.put({"action": "exit"})

    def key(self, mode):
        self.keys.append((mode, time.perf_counter()))

    def modified(self, _):
        if self.editor.edit_modified():
            self.events.append(time.perf_counter())
            self.editor.edit_modified(False)

    def focus(self):
        self.window.deiconify()
        self.root.update()
        window = self.user32.GetAncestor(self.window.winfo_id(), 2)
        self.window.attributes("-topmost", True)
        self.window.lift()
        self.editor.focus_force()
        self.user32.SetForegroundWindow(window)
        self.root.update()
        if self.user32.GetForegroundWindow() != window and window:
            # The desktop may refuse a programmatic foreground change. Click
            # inside the topmost owned editor and verify the resulting HWND.
            x, y = self.editor.winfo_rootx() + 24, self.editor.winfo_rooty() + 24
            click = (Input * 2)(
                Input(0, InputData(mouse=MouseInput(0, 0, 0, 2, 0, 0))),
                Input(0, InputData(mouse=MouseInput(0, 0, 0, 4, 0, 0))),
            )
            if self.user32.SetCursorPos(x, y):
                self.user32.SendInput(2, click, ctypes.sizeof(Input))
                self.root.update()
        self.window.attributes("-topmost", False)
        if self.user32.GetForegroundWindow() != window:
            raise RuntimeError("editor-foreground-unavailable")

    def send_key(self, mode):
        window = self.user32.GetAncestor(self.window.winfo_id(), 2)
        if self.user32.GetForegroundWindow() != window:
            raise RuntimeError("editor-no-longer-foreground")
        vk = VKEYS[mode]
        sequence = (Input * 2)(
            Input(1, InputData(key=KeyInput(vk, 0, 0, 0, 0))),
            Input(1, InputData(key=KeyInput(vk, 0, 2, 0, 0))),
        )
        start = time.perf_counter()
        if self.user32.SendInput(2, sequence, ctypes.sizeof(Input)) != 2:
            raise RuntimeError("sendinput-unavailable")
        return start

    def handle(self, command):
        action = command["action"]
        if action == "reset":
            self.editor.delete("1.0", "end")
            self.editor.edit_modified(False)
            self.events.clear()
            self.keys.clear()
            self.root.clipboard_clear()
            self.root.clipboard_append(SEED)
            self.focus()
            return True
        if action == "key":
            return self.send_key(command["mode"])
        if action == "replace-editor":
            self.window.destroy()
            self.new_window()
            self.focus()
            return True
        if action == "read":
            try:
                clipboard = self.root.clipboard_get()
            except tk.TclError:
                clipboard = None
            return {
                "text": self.editor.get("1.0", "end-1c"), "insertions": self.events,
                "keys": self.keys, "clipboard_restored": clipboard == SEED,
                "clipboard_matches_final": clipboard is not None and clipboard == command.get("final"),
            }
        if action == "exit":
            self.root.destroy()
            return True
        raise RuntimeError("unknown-desktop-command")

    def tick(self):
        stopping = False
        try:
            command = self.queue.get_nowait()
        except queue.Empty:
            pass
        else:
            stopping = command["action"] == "exit"
            try:
                print(json.dumps({"result": self.handle(command)}), flush=True)
            except RuntimeError as error:
                print(json.dumps({"error": str(error)}), flush=True)
        if not stopping:
            self.root.after(5, self.tick)


if __name__ == "__main__":
    if os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("Desktop fixture requires a hosted Windows runner")
    Desktop().root.mainloop()
