"""Workspaces for the panel (WSOS-DSK-003) on Labwc's own desktops.

Debian trixie ships Labwc 0.8.x, which has no workspace protocol for clients: ext-workspace-v1 arrived in Labwc
0.9.0, and wlr-foreign-toplevel says nothing about desktops. So the bridge works with Labwc's own mechanism:

* rc.xml has `<desktops number="4"/>` and key bindings with GoToDesktop / SendToDesktop. Every binding that changes
  the desktop also runs `worksuite-workspace-event <action> <n>`, which tells the bridge (WorkspaceEvents1.Event);
  that is how the bridge knows the current desktop when a person uses the keyboard.
* The panel's switcher and "Move to workspace" send Labwc bindings that exist only for this
  (Ctrl+Alt+Super+F<n> go, Ctrl+Alt+Shift+Super+F<n> send) through the virtual-keyboard protocol (`wtype`). Function
  keys keep their keysym with Shift held, so the bindings match whatever the keyboard layout is.
* Labwc does not report which desktop a window is on. The tracker assigns new windows to the current desktop and
  follows moves it makes or hears about (SendToDesktop acts on the focused window). A window activated from the panel
  takes Labwc to its desktop, and the tracker follows.

When the distribution moves to Labwc ≥ 0.9, a backend on ext-workspace-v1 can replace this without changing the D-Bus
API (ListWorkspaces, ActivateWorkspace, MoveWindowToWorkspace, WorkspacesChanged).
"""
from __future__ import annotations

import shutil
import subprocess
import time
from typing import Callable

from .model import ACTIVATED, NotFound, NotSupported, WindowRegistry, Window

MAX_WORKSPACES = 9


class WorkspaceTracker:
    def __init__(self, registry: WindowRegistry, count: int = 4, wrap: bool = True, clock: Callable[[], float] = time.monotonic):
        if not 1 <= count <= MAX_WORKSPACES:
            raise ValueError("workspace count 1..9")
        self.registry, self.count, self.wrap, self.clock = registry, count, wrap, clock
        self.current = 1
        self.of: dict[str, int] = {}
        self.active: dict[str, bool] = {}
        # Windows as they got focus, newest last: SendToDesktop moves the window that had focus, and Labwc may focus
        # another one before the binding's event reaches the bridge.
        self.focus_log: list[tuple[str, float]] = []
        self.expect: tuple[int, float] | None = None
        self.listeners: list[Callable[[], None]] = []
        registry.listeners.append(self._window_event)
        for w in registry.list():
            self.of[w.handle] = 1

    def _changed(self) -> None:
        for fn in list(self.listeners):
            fn()

    def _window_event(self, kind: str, w: Window) -> None:
        if kind == "added":
            self.of[w.handle] = self.current
            self._changed()
        elif kind == "removed":
            self.active.pop(w.handle, None)
            self.focus_log = [f for f in self.focus_log if f[0] != w.handle]
            if self.of.pop(w.handle, None) is not None:
                self._changed()
        if kind in ("added", "changed"):
            now_active = bool(w.flags & ACTIVATED)
            became = now_active and not self.active.get(w.handle, False)
            self.active[w.handle] = now_active
            if became:
                self.focus_log = (self.focus_log + [(w.handle, self.clock())])[-8:]
                if self.of.get(w.handle, self.current) != self.current:
                    # Labwc goes to the desktop of a window that gets focus (activated from the panel, or by an app).
                    self.current = self.of[w.handle]
                    self._changed()

    def check(self, n: int) -> int:
        if not isinstance(n, int) or not 1 <= n <= self.count:
            raise NotFound(f"no workspace {n!r} (1..{self.count})")
        return n

    def step(self, direction: str) -> int:
        d = -1 if direction == "left" else 1
        n = self.current + d
        if 1 <= n <= self.count:
            return n
        return ((n - 1) % self.count) + 1 if self.wrap else self.current

    def event(self, action: str, n: int = 0) -> None:
        """What a Labwc binding did: goto N, left, right, or move N (the focused window went to N)."""
        if action == "goto":
            target = self.check(n)
        elif action in ("left", "right"):
            target = self.step(action)
        elif action == "move":
            self.check(n)
            now = self.clock()
            if self.expect and self.expect[0] == n and now - self.expect[1] < 2.0:
                self.expect = None  # the panel's own move, already recorded
                return
            log = self.focus_log
            if not log:
                return
            # A focus change in the last half second came from the move itself: the moved window is the one before.
            handle = log[-2][0] if len(log) >= 2 and now - log[-1][1] < 0.5 and self.of.get(log[-1][0]) == self.current else log[-1][0]
            self.of[handle] = n
            self._changed()
            return
        else:
            raise NotFound(f"unknown workspace event {action!r}")
        if target != self.current:
            self.current = target
            self._changed()

    def moved(self, handle: str, n: int) -> None:
        """The panel moved this window (the binding's own event that follows is then ignored)."""
        self.of[handle] = self.check(n)
        self.expect = (n, self.clock())
        self._changed()

    def windows(self) -> dict[str, int]:
        return {w.handle: self.of.get(w.handle, self.current) for w in self.registry.list()}


Runner = Callable[[list[str]], int]


def _run(argv: list[str]) -> int:
    return subprocess.run(argv, check=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode


class LabwcKeys:
    """Sends the bridge-only Labwc bindings with wtype (zwp_virtual_keyboard_v1, which Labwc supports)."""

    def __init__(self, run: Runner = _run, which: Callable[[str], str | None] = shutil.which, settle_s: float = 0.05):
        self.run, self.which, self.settle_s = run, which, settle_s

    def available(self) -> bool:
        return self.which("wtype") is not None

    @staticmethod
    def argv(n: int, send: bool) -> list[str]:
        mods = ["ctrl", "alt", "logo"] + (["shift"] if send else [])
        out = ["wtype"]
        for m in mods:
            out += ["-M", m]
        out += ["-k", f"F{n}"]
        for m in reversed(mods):
            out += ["-m", m]
        return out

    def go(self, n: int) -> None:
        if self.run(self.argv(n, False)) != 0:
            raise NotSupported("could not send the workspace key to Labwc (wtype)")

    def send_focused(self, n: int) -> None:
        time.sleep(self.settle_s)  # let Labwc focus the window activated just before
        if self.run(self.argv(n, True)) != 0:
            raise NotSupported("could not send the workspace key to Labwc (wtype)")


def rc_bindings(count: int = 4) -> str:
    """The rc.xml keybinds for `count` desktops (kept in services/session/labwc/rc.xml; tests compare)."""
    ev = "/usr/lib/worksuite/worksuite-workspace-event"
    lines = []
    for n in range(1, count + 1):
        lines.append(f'    <keybind key="W-{n}"><action name="GoToDesktop" to="{n}"/><action name="Execute" command="{ev} goto {n}"/></keybind>')
    for n in range(1, count + 1):
        lines.append(f'    <keybind key="W-S-{n}"><action name="SendToDesktop" to="{n}" follow="no"/><action name="Execute" command="{ev} move {n}"/></keybind>')
    lines.append(f'    <keybind key="C-A-Left"><action name="GoToDesktop" to="left" wrap="yes"/><action name="Execute" command="{ev} left"/></keybind>')
    lines.append(f'    <keybind key="C-A-Right"><action name="GoToDesktop" to="right" wrap="yes"/><action name="Execute" command="{ev} right"/></keybind>')
    for n in range(1, count + 1):
        lines.append(f'    <keybind key="C-A-W-F{n}"><action name="GoToDesktop" to="{n}"/><action name="Execute" command="{ev} goto {n}"/></keybind>')
    for n in range(1, count + 1):
        lines.append(f'    <keybind key="C-A-S-W-F{n}"><action name="SendToDesktop" to="{n}" follow="no"/><action name="Execute" command="{ev} move {n}"/></keybind>')
    return "\n".join(lines)
