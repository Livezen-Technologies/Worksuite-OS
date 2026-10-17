"""Sends the keyboard's output to the focused app through the virtual-keyboard protocol (wtype, which Labwc supports).

Text goes on wtype's standard input (`wtype -`), never on its command line, so what someone types (passwords too) does
not show up in the process list. Keys are named keysyms from a fixed set.
"""
from __future__ import annotations

import subprocess
from typing import Callable

KEYS = {"BackSpace", "Return", "Tab", "Left", "Right", "Up", "Down", "Escape", "Delete", "Home", "End"}
Run = Callable[[list[str], bytes | None], int]


def _run(argv: list[str], stdin: bytes | None) -> int:
    try:
        return subprocess.run(argv, input=stdin, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False).returncode
    except (OSError, subprocess.TimeoutExpired):
        return 1


def _clipboard() -> str:
    try:
        r = subprocess.run(["wl-paste", "--no-newline", "--type", "text/plain"], capture_output=True, timeout=3, check=False)
        return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


class Output:
    def __init__(self, run: Run = _run, clipboard: Callable[[], str] = _clipboard, on_hide: Callable[[], None] = lambda: None):
        self.run, self.clipboard, self.on_hide = run, clipboard, on_hide

    def apply(self, actions: list[tuple]) -> None:
        pending = ""
        for a in actions:
            if a[0] == "text":
                pending += a[1]
                continue
            if pending:
                self.run(["wtype", "-"], pending.encode())
                pending = ""
            if a[0] == "key" and a[1] in KEYS:
                self.run(["wtype", "-k", a[1]], None)
            elif a[0] == "paste":
                text = self.clipboard()[:10000]
                if text:
                    self.run(["wtype", "-"], text.encode())
            elif a[0] == "hide":
                self.on_hide()
        if pending:
            self.run(["wtype", "-"], pending.encode())
