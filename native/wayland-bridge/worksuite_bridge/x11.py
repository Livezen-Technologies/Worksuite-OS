"""X11 apps (Xwayland): Labwc names their windows by the WM_CLASS instance ("Navigator" for Firefox), while desktop
entries match the class (StartupWMClass=firefox-esr), so the taskbar showed a letter tile for them. The bridge lists
such a window under its class instead, read from the X server with xwininfo -root -tree. Only while Xwayland runs:
connecting to the X socket would start it (Labwc starts Xwayland on demand).
"""
from __future__ import annotations

import os
import re
import subprocess
from typing import Callable

PAIR = re.compile(r'\("((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"\)')


def parse_tree(text: str) -> dict[str, str]:
    """instance → class from `xwininfo -root -tree` lines such as  0x400003 "Title": ("Navigator" "firefox-esr")."""
    out: dict[str, str] = {}
    for m in PAIR.finditer(text):
        inst, cls = m.group(1), m.group(2)
        if inst and cls:
            out.setdefault(inst, cls)
    return out


def xwayland_running(proc: str = "/proc", uid: int | None = None) -> bool:
    uid = os.getuid() if uid is None else uid
    try:
        names = os.listdir(proc)
    except OSError:
        return False
    for pid in names:
        if not pid.isdigit():
            continue
        try:
            if os.stat(f"{proc}/{pid}").st_uid != uid:
                continue
            with open(f"{proc}/{pid}/comm", encoding="utf-8") as f:
                if f.read().strip() == "Xwayland":
                    return True
        except OSError:
            continue
    return False


def run_xwininfo() -> str:
    if not os.environ.get("DISPLAY"):
        return ""
    try:
        return subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True, timeout=2, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


class X11Classes:
    def __init__(self, tree: Callable[[], str] = run_xwininfo, running: Callable[[], bool] = xwayland_running):
        self.tree, self.running = tree, running
        self.map: dict[str, str] = {}

    def resolve(self, app_id: str) -> str:
        """The class for an X11 window's instance name; any other app id unchanged."""
        if not app_id:
            return app_id
        if app_id not in self.map and self.running():
            self.map = parse_tree(self.tree())
        return self.map.get(app_id, app_id)
