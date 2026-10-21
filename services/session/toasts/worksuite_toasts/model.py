"""The toast stack and the shell's line protocol (no GTK here, so it is unit-tested).

The shell (shell/electron/toastHost.ts) writes one JSON object per line on standard input:
  {"op": "show", "key": "app-12", "title": "...", "body": "...", "tone": "ok|warn|error", "icon": "...", "sticky": false}
  {"op": "hide", "key": "app-12"}      {"op": "clear"}
  {"op": "osd", "kind": "volume|mic|brightness", "value": 0-100, "muted": false}   (Fn keys, #62: a level bar)
and reads "click <key>" (the card was clicked: open or focus the app) and "closed <key>" (dismissed or timed out).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

MAX_SHOWN = 3
TIMEOUT_MS = 6000
KEY = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
TONES = ("ok", "warn", "error")
OSD_KINDS = ("volume", "mic", "brightness")
OSD_MS = 1500


@dataclass
class Toast:
    key: str
    title: str
    body: str = ""
    tone: str = "ok"
    icon: str = ""
    sticky: bool = False


@dataclass
class Osd:
    kind: str
    value: int
    muted: bool = False


def parse(line: str) -> tuple[str, object] | None:
    """One protocol line → ("show", Toast) | ("hide", key) | ("clear", None) | ("osd", Osd); None for anything else."""
    try:
        m = json.loads(line)
    except ValueError:
        return None
    if not isinstance(m, dict):
        return None
    op = m.get("op")
    if op == "clear":
        return ("clear", None)
    if op == "osd":
        v = m.get("value")
        if m.get("kind") not in OSD_KINDS or not isinstance(v, int) or isinstance(v, bool):
            return None
        return ("osd", Osd(m["kind"], max(0, min(100, v)), m.get("muted") is True))
    key = m.get("key")
    if not isinstance(key, str) or not KEY.match(key):
        return None
    if op == "hide":
        return ("hide", key)
    if op != "show":
        return None
    s = lambda k, n: str(m.get(k) or "").replace("\0", "")[:n]  # noqa: E731
    icon = s("icon", 512)
    if icon and not (icon.startswith("/") or re.match(r"^[A-Za-z0-9][A-Za-z0-9._+@-]*$", icon)):
        icon = ""
    return ("show", Toast(key, s("title", 200) or " ", s("body", 400), m.get("tone") if m.get("tone") in TONES else "ok",
                          icon, bool(m.get("sticky"))))


class Stack:
    """Newest first, at most MAX_SHOWN; a toast shown again with the same key is replaced and moves to the top."""

    def __init__(self) -> None:
        self.items: list[Toast] = []

    def show(self, t: Toast) -> list[Toast]:
        """Returns the toasts pushed out (to report them closed)."""
        self.items = [t] + [x for x in self.items if x.key != t.key]
        dropped, self.items = self.items[MAX_SHOWN:], self.items[:MAX_SHOWN]
        return dropped

    def hide(self, key: str) -> bool:
        had = any(x.key == key for x in self.items)
        self.items = [x for x in self.items if x.key != key]
        return had

    def clear(self) -> list[Toast]:
        gone, self.items = self.items, []
        return gone
