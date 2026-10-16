"""Desktops (Windows 11-style virtual desktops, WSOS-DSK-003) on Labwc's own desktops.

Debian trixie ships Labwc 0.8.x, which has no workspace protocol for clients: ext-workspace-v1 arrived in Labwc
0.9.0, and wlr-foreign-toplevel says nothing about desktops. So the bridge works with Labwc's own mechanism:

* rc.xml has `<desktops number="N">` with names, and key bindings with GoToDesktop / SendToDesktop. Every binding that
  changes the desktop also runs `worksuite-workspace-event <action> <n>`, which tells the bridge
  (WorkspaceEvents1.Event); that is how the bridge knows the current desktop when a person uses the keyboard.
* The shell's switcher, Task View and "Move to" send Labwc bindings that exist only for this
  (Ctrl+Alt+Super+F<n> go, Ctrl+Alt+Shift+Super+F<n> send, Ctrl+Alt+Super+F24 toggle "on all desktops") through the
  virtual-keyboard protocol (`wtype`). Function keys keep their keysym with Shift held, so the bindings match whatever
  the keyboard layout is. F1…F16 cover the 16 desktops.
* Labwc does not report which desktop a window is on. The tracker assigns new windows to the current desktop and
  follows moves it makes or hears about (SendToDesktop acts on the focused window). A window activated from the panel
  takes Labwc to its desktop, and the tracker follows.

Dynamic desktops (create, close, reorder, rename). Labwc 0.8 reads the desktop count and names from rc.xml only, so
the bridge rewrites the `<desktops>` element of the user's rc.xml (~/.config/worksuite/labwc/rc.xml, the file
worksuite-session starts Labwc with) and runs `labwc --reconfigure` (SIGHUP). On reconfigure Labwc 0.8 keeps its
workspace objects in order (workspaces_reconfigure(): existing ones are renamed, missing ones appended, surplus ones
removed from the END, their windows going to the first desktop). So window assignments survive a reconfigure as long
as only the last desktop is ever removed. Closing or reordering a desktop in the middle is therefore done in two steps:
the bridge first moves every affected window to its final index with the send binding (it knows where each one is),
then shrinks or renames. Windows on all desktops (omnipresent) are never moved.

When the distribution moves to Labwc >= 0.9, a backend on ext-workspace-v1 can replace this without changing the
D-Bus API.
"""
from __future__ import annotations

import asyncio
import os
import re
import secrets
import shutil
import subprocess
import time
from pathlib import Path
from typing import Awaitable, Callable

from .model import ACTIVATED, MINIMIZED, NotFound, NotSupported, Window, WindowRegistry

MAX_WORKSPACES = 16
NAME_MAX = 40
# The shell's own windows: always on bottom (so on every desktop) through rc.xml's window rule, never moved; focusing
# one does not change the desktop.
OWN_APP_IDS = {"worksuite-shell", "worksuite", "electron"}


def clean_name(name: str) -> str:
    """A desktop name as stored: printable, one line, at most NAME_MAX characters ("" = the default name)."""
    s = "".join(ch for ch in str(name) if ch.isprintable()).strip()
    return s[:NAME_MAX]


class WorkspaceTracker:
    def __init__(self, registry: WindowRegistry, count: int = 4, wrap: bool = False, clock: Callable[[], float] = time.monotonic,
                 names: list[str] | None = None):
        if not 1 <= count <= MAX_WORKSPACES:
            raise ValueError(f"workspace count 1..{MAX_WORKSPACES}")
        self.registry, self.count, self.wrap, self.clock = registry, count, wrap, clock
        self.current = 1
        self.names: list[str] = [clean_name(n) for n in (names or [])][:count] + [""] * max(0, count - len(names or []))
        self.prefix = "Desktop"
        # A stable id per desktop that follows it through moves and closes (the shell keys wallpapers by it).
        self.ids: list[str] = [self.new_id() for _ in range(count)]
        self.of: dict[str, int] = {}
        self.sticky: set[str] = set()         # windows shown on every desktop (Labwc omnipresent)
        self.sticky_apps: set[str] = set()    # app_ids whose windows are shown on every desktop
        self.switcher_all = False             # Alt+Tab shows windows from every desktop
        self.active: dict[str, bool] = {}
        # Windows as they got focus, newest last: SendToDesktop moves the window that had focus, and Labwc may focus
        # another one before the binding's event reaches the bridge.
        self.focus_log: list[tuple[str, float]] = []
        self.last_focus: dict[str, float] = {}  # every window's last focus (the most recent one is on top in Labwc)
        # Moves the bridge made itself: their bindings report too, and those echoes are ignored.
        self.expect: list[tuple[int, float]] = []
        self.listeners: list[Callable[[], None]] = []
        self.added: list[Callable[[Window], None]] = []
        registry.listeners.append(self._window_event)
        for w in registry.list():
            self.of[w.handle] = 1

    @staticmethod
    def new_id() -> str:
        return "d" + secrets.token_hex(4)

    def _changed(self) -> None:
        for fn in list(self.listeners):
            fn()

    def _window_event(self, kind: str, w: Window) -> None:
        if kind == "added":
            self.of[w.handle] = self.current
            self._changed()
            for fn in list(self.added):
                fn(w)
        elif kind == "removed":
            self.active.pop(w.handle, None)
            self.sticky.discard(w.handle)
            self.focus_log = [f for f in self.focus_log if f[0] != w.handle]
            self.last_focus.pop(w.handle, None)
            if self.of.pop(w.handle, None) is not None:
                self._changed()
        if kind in ("added", "changed"):
            now_active = bool(w.flags & ACTIVATED)
            became = now_active and not self.active.get(w.handle, False)
            self.active[w.handle] = now_active
            if became:
                self.focus_log = (self.focus_log + [(w.handle, self.clock())])[-8:]
                self.last_focus[w.handle] = self.clock()
                if w.handle not in self.sticky and w.app_id.lower() not in OWN_APP_IDS \
                        and self.of.get(w.handle, self.current) != self.current:
                    # Labwc goes to the desktop of a window that gets focus (activated from the panel, or by an app).
                    self.current = self.of[w.handle]
                    self._changed()

    def top_app(self, n: int) -> Window | None:
        """The app window (not the shell's, not minimized) on desktop n, or on every desktop, focused most recently."""
        best: tuple[float, int] | None = None
        pick = None
        for i, w in enumerate(self.registry.list()):
            if w.app_id.lower() in OWN_APP_IDS or w.flags & MINIMIZED:
                continue
            if w.handle not in self.sticky and self.of.get(w.handle, self.current) != n:
                continue
            key = (self.last_focus.get(w.handle, -1.0), i)   # never focused: the newest window
            if best is None or key > best:
                best, pick = key, w
        return pick

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
            self.expect = [e for e in self.expect if now - e[1] < 2.0]
            for i, e in enumerate(self.expect):
                if e[0] == n:
                    del self.expect[i]  # the bridge's own move, already recorded
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
        """The bridge moved this window (the binding's own event that follows is then ignored)."""
        self.of[handle] = self.check(n)
        self.expect.append((n, self.clock()))
        self._changed()

    def windows(self) -> dict[str, int]:
        return {w.handle: self.of.get(w.handle, self.current) for w in self.registry.list()}

    def display_names(self) -> list[str]:
        return [self.names[i] if i < len(self.names) and self.names[i] else f"{self.prefix} {i + 1}" for i in range(self.count)]

    # ---- plans for dynamic desktops (pure: what has to move where; Desktops carries them out) ------------------
    def _movable(self) -> dict[str, int]:
        own = {w.handle for w in self.registry.list() if w.app_id.lower() in OWN_APP_IDS}
        return {h: d for h, d in self.windows().items() if h not in self.sticky and h not in own}

    def plan_remove(self, n: int) -> tuple[dict[str, int], int]:
        """Close desktop n: its windows go to the desktop on its left (or the next one, for the first); desktops after
        it shift down one. Returns the window moves (indices valid before AND after the shrink) and the new current."""
        self.check(n)
        if self.count <= 1:
            raise NotSupported("the last desktop cannot be closed")

        def new(d: int) -> int:
            return d if d < n else max(1, n - 1) if d == n else d - 1
        moves = {h: new(d) for h, d in self._movable().items() if new(d) != d}
        return moves, new(self.current)

    def plan_reorder(self, src: int, dst: int) -> tuple[dict[str, int], int, list[int]]:
        """Move desktop src to position dst. Returns the window moves, the new current and the new order (old indices)."""
        self.check(src)
        self.check(dst)
        order = list(range(1, self.count + 1))
        order.insert(dst - 1, order.pop(src - 1))
        pos = {old: i + 1 for i, old in enumerate(order)}
        moves = {h: pos[d] for h, d in self._movable().items() if pos.get(d, d) != d}
        return moves, pos[self.current], order


Runner = Callable[[list[str]], int]


def _run(argv: list[str]) -> int:
    return subprocess.run(argv, check=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode


OMNI_KEY = "F24"
# Lift the shell's windows out of Labwc's always-on-bottom layer, over the apps and on every desktop (its launcher,
# notification centre, Files, Task View…), and put them back. Both bindings use ForEach with a query on the shell's
# app_id, so they act on the shell's windows whatever has the keyboard focus, and both are idempotent: "omnipresent"
# marks a lifted shell window (the lift sets it together with leaving always-on-bottom), so lifting a lifted shell only
# raises it again and lowering a lowered one does nothing. (A focus-dependent toggle could act on the app window when
# the focus had not moved yet, and two toggles in a row put the shell back where it was.)
# Labwc < 0.8 ignores the omnipresent query (it would toggle again), so the bridge also keeps the state and sends the
# lift only to a lowered shell; RAISE_KEY (raise only) brings a lifted shell back over an app.
LIFT_KEY = "F23"
LOWER_KEY = "F22"
RAISE_KEY = "F21"
SHELL_QUERY = 'identifier="worksuite-shell"'


class LabwcKeys:
    """Sends the bridge-only Labwc bindings with wtype (zwp_virtual_keyboard_v1, which Labwc supports)."""

    def __init__(self, run: Runner = _run, which: Callable[[str], str | None] = shutil.which, settle_s: float = 0.05):
        self.run, self.which, self.settle_s = run, which, settle_s

    def available(self) -> bool:
        return self.which("wtype") is not None

    @staticmethod
    def argv(n: int | str, send: bool) -> list[str]:
        mods = ["ctrl", "alt", "logo"] + (["shift"] if send else [])
        out = ["wtype"]
        for m in mods:
            out += ["-M", m]
        out += ["-k", n if isinstance(n, str) else f"F{n}"]
        for m in reversed(mods):
            out += ["-m", m]
        return out

    def _send(self, argv: list[str]) -> None:
        if self.run(argv) != 0:
            raise NotSupported("could not send the workspace key to Labwc (wtype)")

    def go(self, n: int) -> None:
        self._send(self.argv(n, False))

    def send_focused(self, n: int) -> None:
        time.sleep(self.settle_s)  # let Labwc focus the window activated just before
        self._send(self.argv(n, True))

    def toggle_omnipresent(self) -> None:
        time.sleep(self.settle_s)
        self._send(self.argv(OMNI_KEY, False))

    def lift(self) -> None:
        self._send(self.argv(LIFT_KEY, False))

    def lower(self) -> None:
        self._send(self.argv(LOWER_KEY, False))

    def raise_shell(self) -> None:
        self._send(self.argv(RAISE_KEY, False))


# ---- rc.xml ---------------------------------------------------------------------------------------------------
_DESKTOPS = re.compile(r"<desktops\b[^>]*/>|<desktops\b[^>]*>.*?</desktops>", re.S)
_SWITCHER = re.compile(r"<windowSwitcher\b[^>]*?(/?)>")


def _xml(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _unxml(s: str) -> str:
    return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&amp;", "&")


def desktops_element(names: list[str]) -> str:
    inner = "".join(f"<name>{_xml(n)}</name>" for n in names)
    # popupTime 0: the shell shows the desktop's name itself (Labwc's OSD would show it a second time).
    return f'<desktops number="{len(names)}"><popupTime>0</popupTime><names>{inner}</names></desktops>'


def parse_desktops(rc: str) -> tuple[int, list[str]]:
    m = _DESKTOPS.search(rc)
    if not m:
        return 1, []
    el = m.group(0)
    num = re.search(r'number="(\d+)"', el)
    names = [_unxml(x) for x in re.findall(r"<name>(.*?)</name>", el, re.S)]
    count = max(int(num.group(1)) if num else 1, len(names))
    return max(1, min(MAX_WORKSPACES, count)), names[:MAX_WORKSPACES]


def rewrite_rc(rc: str, names: list[str], switcher_all: bool) -> str:
    """rc.xml with the desktops element and the window switcher's scope replaced (everything else kept)."""
    el = desktops_element(names)
    out = _DESKTOPS.sub(lambda _m: el, rc, count=1) if _DESKTOPS.search(rc) else rc.replace("<keyboard>", f"{el}\n  <keyboard>", 1)
    return _set_switcher(out, switcher_all)


def _set_switcher(rc: str, switcher_all: bool) -> str:
    flag = "yes" if switcher_all else "no"

    def sw(m: re.Match[str]) -> str:
        tag = re.sub(r'\s+allWorkspaces="[^"]*"', "", m.group(0)[:-2 if m.group(1) else -1])
        return f'{tag} allWorkspaces="{flag}"{m.group(1)}>'
    if _SWITCHER.search(rc):
        return _SWITCHER.sub(sw, rc, count=1)
    return rc.replace("<keyboard>", f'<windowSwitcher allWorkspaces="{flag}"/>\n  <keyboard>', 1)


TOUCH_BEGIN = "<!-- worksuite-touch:begin"
TOUCH_END = "<!-- worksuite-touch:end -->"
_TOUCH = re.compile(re.escape(TOUCH_BEGIN) + r".*?" + re.escape(TOUCH_END) + r"\n?", re.S)
# Settings › Keyboard › Shortcuts (shell/src/lib/shortcuts.ts): the user's key bindings, a block at the end of <keyboard>.
SHORTCUTS_BEGIN = "<!-- worksuite-shortcuts:begin"
SHORTCUTS_END = "<!-- worksuite-shortcuts:end -->"
_SHORTCUTS = re.compile(r"[ \t]*" + re.escape(SHORTCUTS_BEGIN) + r".*?" + re.escape(SHORTCUTS_END) + r"\n?", re.S)


def _put_shortcuts(rc: str, block: str) -> str:
    """rc.xml with the shortcuts block (and no other) as the last thing in <keyboard>, where its bindings win."""
    rc = _SHORTCUTS.sub("", rc)
    close = rc.rfind("</keyboard>")
    block = block.rstrip("\n") + "\n"
    if close < 0:
        end = rc.rfind("</labwc_config>")
        kb = f"  <keyboard>\n{block}  </keyboard>\n"
        return rc[:end] + kb + rc[end:] if end >= 0 else rc.rstrip("\n") + "\n" + kb
    line = rc.rfind("\n", 0, close) + 1
    return rc[:line] + block + rc[line:]


def refresh_rc(user: str, system: str) -> str:
    """The user's rc.xml rebuilt from the system file, keeping only what belongs to the user: the desktops (count and
    names), Alt+Tab's scope, the touchscreen block of Settings › Touchscreen & pen (shell/electron/touch.ts) and the
    key bindings of Settings › Keyboard › Shortcuts (shell/src/lib/shortcuts.ts). So a
    copy written by an older version picks up the current window rules and key bindings (the shell's always-on-bottom
    rule, the Task View binding) instead of keeping stale ones."""
    if not system.strip():
        return user
    if not user.strip():
        return system
    out = system
    m = _DESKTOPS.search(user)
    if m:
        out = _DESKTOPS.sub(lambda _m: m.group(0), out, count=1) if _DESKTOPS.search(out) else out.replace("<keyboard>", f"{m.group(0)}\n  <keyboard>", 1)
    sw = re.search(r'<windowSwitcher\b[^>]*?allWorkspaces="(yes|no)"', user)
    if sw:
        out = _set_switcher(out, sw.group(1) == "yes")
    touch = _TOUCH.search(user)
    if touch:
        out = _TOUCH.sub("", out)
        close = out.rfind("</labwc_config>")
        block = touch.group(0).rstrip("\n") + "\n"
        out = out[:close] + block + out[close:] if close >= 0 else out.rstrip("\n") + "\n" + block
    keys = _SHORTCUTS.search(user)
    if keys:
        out = _put_shortcuts(out, keys.group(0))
    return out


class LabwcConfig:
    """The user's rc.xml (worksuite-session starts Labwc with its folder) and `labwc --reconfigure`."""

    def __init__(self, user_rc: Path | None = None, system_rc: Path = Path("/etc/xdg/worksuite/labwc/rc.xml"), run: Runner = _run):
        home = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
        self.user_rc = user_rc or Path(home) / "worksuite" / "labwc" / "rc.xml"
        self.system_rc, self.run = system_rc, run

    def read(self) -> str:
        for p in (self.user_rc, self.system_rc):
            try:
                return p.read_text()
            except OSError:
                continue
        return ""

    def desktops(self) -> tuple[int, list[str]]:
        return parse_desktops(self.read())

    def write(self, names: list[str], switcher_all: bool) -> None:
        # From the system file (current window rules and bindings), with the user's touchscreen block kept.
        try:
            system = self.system_rc.read_text()
        except OSError:
            system = ""
        text = rewrite_rc(refresh_rc(self.read(), system), names, switcher_all)
        self.user_rc.parent.mkdir(parents=True, exist_ok=True)
        if self.user_rc.is_symlink():  # starts as a link to the system file (worksuite-session)
            self.user_rc.unlink()
        tmp = self.user_rc.with_name(self.user_rc.name + ".tmp")
        tmp.write_text(text)
        tmp.replace(self.user_rc)

    def reconfigure(self) -> None:
        if self.run(["labwc", "--reconfigure"]) == 0:
            return
        pid = os.environ.get("LABWC_PID", "")
        if pid.isdigit() and self.run(["kill", "-HUP", pid]) == 0:
            return
        raise NotSupported("could not reload Labwc's configuration")


Blocking = Callable[..., Awaitable[object]]


class Desktops:
    """Create, close, reorder and rename desktops; windows on all desktops. Runs on the event loop: window
    activation goes through the Wayland backend (loop thread), key presses and Labwc reloads run in `blocking`."""

    def __init__(self, tracker: WorkspaceTracker, keys: LabwcKeys, config: LabwcConfig, activate: Callable[[Window], None],
                 blocking: Blocking | None = None, reload_settle_s: float = 0.15):
        self.ws, self.keys, self.config, self.activate = tracker, keys, config, activate
        self.blocking = blocking or self._executor
        self.reload_settle_s = reload_settle_s
        self.lock = asyncio.Lock()
        self.lifted: set[str] = set()  # shell windows lifted over the apps (launcher, Task View, …)
        tracker.added.append(self._new_window)
        tracker.registry.listeners.append(lambda kind, w: self.lifted.discard(w.handle) if kind == "removed" else None)

    @staticmethod
    async def _executor(fn: Callable[..., object], *args: object) -> object:
        return await asyncio.get_running_loop().run_in_executor(None, fn, *args)

    def _focused(self) -> Window | None:
        return next((w for w in self.ws.registry.list() if w.flags & ACTIVATED), None)

    async def _apply(self, moves: dict[str, int]) -> None:
        """Send each window to its desktop (focus it, then the send binding), then give focus back."""
        if not moves:
            return
        focused = self._focused()
        for handle, n in moves.items():
            try:
                w = self.ws.registry.get(handle)
            except NotFound:
                continue
            self.activate(w)
            self.ws.moved(handle, n)
            await self.blocking(self.keys.send_focused, n)
        if focused is not None and focused.handle in {w.handle for w in self.ws.registry.list()}:
            self.activate(focused)

    async def _reload(self, names: list[str]) -> None:
        await self.blocking(self.config.write, names, self.ws.switcher_all)
        await self.blocking(self.config.reconfigure)
        await asyncio.sleep(self.reload_settle_s)

    async def _go(self, n: int) -> None:
        await self.blocking(self.keys.go, n)
        self.ws.event("goto", n)

    async def create(self) -> int:
        async with self.lock:
            ws = self.ws
            if ws.count >= MAX_WORKSPACES:
                raise NotSupported(f"at most {MAX_WORKSPACES} desktops")
            names = ws.names + [""]
            await self._reload(self._labwc_names(names))
            ws.names, ws.count = names, ws.count + 1
            ws.ids = ws.ids + [ws.new_id()]
            await self._go(ws.count)  # Windows switches to the new desktop
            ws._changed()
            return ws.count

    async def remove(self, n: int) -> None:
        async with self.lock:
            ws = self.ws
            moves, current = ws.plan_remove(n)
            await self._apply(moves)
            names = ws.names[: n - 1] + ws.names[n:]
            # Go to the surviving desktop before the shrink so Labwc never shows a desktop that is about to go.
            await self._go(current if current < ws.count else max(1, ws.count - 1))
            await self._reload(self._labwc_names(names))
            ws.names, ws.count = names, ws.count - 1
            ws.ids = ws.ids[: n - 1] + ws.ids[n:]
            ws.of = {h: min(d, ws.count) for h, d in ws.of.items()}
            ws.current = min(current, ws.count)
            ws._changed()

    async def reorder(self, src: int, dst: int) -> None:
        async with self.lock:
            ws = self.ws
            if src == dst:
                ws.check(src)
                return
            moves, current, order = ws.plan_reorder(src, dst)
            await self._apply(moves)
            names = [ws.names[i - 1] for i in order]
            await self._reload(self._labwc_names(names))
            ws.names = names
            ws.ids = [ws.ids[i - 1] for i in order]
            await self._go(current)
            ws._changed()

    async def rename(self, n: int, name: str) -> None:
        async with self.lock:
            ws = self.ws
            ws.check(n)
            names = list(ws.names)
            names[n - 1] = clean_name(name)
            await self._reload(self._labwc_names(names))
            ws.names = names
            ws._changed()

    async def restore(self, names: list[str], prefix: str = "") -> None:
        """Sign-in: the synced desktops (count and names). Windows past the new count go to the last desktop."""
        async with self.lock:
            ws = self.ws
            clean = [clean_name(x) for x in names][:MAX_WORKSPACES] or [""]
            if prefix.strip():
                ws.prefix = clean_name(prefix) or ws.prefix
            if clean == ws.names and len(clean) == ws.count:
                await self._reload(self._labwc_names(clean))
                ws._changed()
                return
            n = len(clean)
            if n < ws.count:
                await self._apply({h: n for h, d in ws._movable().items() if d > n})
                if ws.current > n:
                    await self._go(n)
            await self._reload(self._labwc_names(clean))
            ws.names, ws.count = clean, n
            ws.ids = (ws.ids + [ws.new_id() for _ in range(n)])[:n]
            ws.of = {h: min(d, n) for h, d in ws.of.items()}
            ws.current = min(ws.current, n)
            ws._changed()

    def _labwc_names(self, names: list[str]) -> list[str]:
        return [x or f"{self.ws.prefix} {i + 1}" for i, x in enumerate(names)]

    async def set_switcher_all(self, on: bool) -> None:
        async with self.lock:
            self.ws.switcher_all = bool(on)
            await self._reload(self._labwc_names(self.ws.names))
            self.ws._changed()

    async def set_window_sticky(self, handle: str, on: bool) -> None:
        async with self.lock:
            await self._sticky(self.ws.registry.get(handle), on)

    async def _sticky(self, w: Window, on: bool) -> None:
        ws = self.ws
        if (w.handle in ws.sticky) == bool(on):
            return
        focused = self._focused()
        self.activate(w)
        await self.blocking(self.keys.toggle_omnipresent)
        if on:
            ws.sticky.add(w.handle)
        else:
            ws.sticky.discard(w.handle)
            ws.of[w.handle] = ws.current  # Labwc leaves it on the desktop being shown
        if focused is not None and focused.handle != w.handle:
            self.activate(focused)
        ws._changed()

    async def set_app_sticky(self, app_id: str, on: bool) -> None:
        async with self.lock:
            ws = self.ws
            if on:
                ws.sticky_apps.add(app_id)
            else:
                ws.sticky_apps.discard(app_id)
            for w in ws.registry.list():
                if w.app_id == app_id:
                    await self._sticky(w, on)
            ws._changed()

    async def set_shell_raised(self, handle: str, on: bool) -> None:
        """The shell's windows over the apps (on every desktop) while something of the shell's is open, then back below
        them. Raising always raises (and focuses) again, also when already lifted: an app may have been put over it.
        Lowering gives the focus to the app the person used last on the desktop shown."""
        async with self.lock:
            w = self.ws.registry.get(handle)
            if w.app_id.lower() not in OWN_APP_IDS:
                raise NotFound(f"{handle!r} is not a shell window")
            if on:
                await self.blocking(self.keys.raise_shell if handle in self.lifted else self.keys.lift)
                self.activate(w)   # keyboard focus for the launcher's search, Task View's keys…
                self.lifted.add(handle)
            else:
                if handle in self.lifted:
                    await self.blocking(self.keys.lower)
                self.lifted.discard(handle)
                self.focus_top_app()

    def focus_top_app(self, n: int | None = None) -> Window | None:
        """Focus the window the person used last on desktop n (default: the one shown), if any is open there."""
        w = self.ws.top_app(self.ws.current if n is None else n)
        if w is not None and not w.flags & ACTIVATED:
            self.activate(w)
        return w

    def _new_window(self, w: Window) -> None:
        if w.app_id in self.ws.sticky_apps:
            async def later() -> None:
                async with self.lock:
                    await self._sticky(w, True)
            try:
                asyncio.get_running_loop().create_task(later())
            except RuntimeError:
                pass


def rc_bindings(count: int = MAX_WORKSPACES) -> str:
    """The rc.xml keybinds (kept in services/session/labwc/rc.xml; tests compare). Super+1…9 / Super+Shift+1…9 for the
    first nine desktops, Ctrl+Super+Left/Right, Ctrl+Super+D (new), Ctrl+Super+F4 (close) and the bridge-only keys."""
    ev = "/usr/lib/worksuite/worksuite-workspace-event"
    lines = []
    for n in range(1, min(9, count) + 1):
        lines.append(f'    <keybind key="W-{n}"><action name="GoToDesktop" to="{n}"/><action name="Execute" command="{ev} goto {n}"/></keybind>')
    for n in range(1, min(9, count) + 1):
        lines.append(f'    <keybind key="W-S-{n}"><action name="SendToDesktop" to="{n}" follow="no"/><action name="Execute" command="{ev} move {n}"/></keybind>')
    for mods in ("C-W", "C-A"):
        lines.append(f'    <keybind key="{mods}-Left"><action name="GoToDesktop" to="left" wrap="no"/><action name="Execute" command="{ev} left"/></keybind>')
        lines.append(f'    <keybind key="{mods}-Right"><action name="GoToDesktop" to="right" wrap="no"/><action name="Execute" command="{ev} right"/></keybind>')
    lines.append(f'    <keybind key="C-W-d"><action name="Execute" command="{ev} new"/></keybind>')
    lines.append(f'    <keybind key="C-W-F4"><action name="Execute" command="{ev} close"/></keybind>')
    for n in range(1, count + 1):
        lines.append(f'    <keybind key="C-A-W-F{n}"><action name="GoToDesktop" to="{n}"/><action name="Execute" command="{ev} goto {n}"/></keybind>')
    for n in range(1, count + 1):
        lines.append(f'    <keybind key="C-A-S-W-F{n}"><action name="SendToDesktop" to="{n}" follow="no"/><action name="Execute" command="{ev} move {n}"/></keybind>')
    lines.append(f'    <keybind key="C-A-W-{LIFT_KEY}"><action name="ForEach"><query {SHELL_QUERY} omnipresent="no"/><then><action name="ToggleAlwaysOnBottom"/>'
                 f'<action name="ToggleOmnipresent"/></then></action><action name="ForEach"><query {SHELL_QUERY}/><then><action name="Raise"/></then></action></keybind>')
    lines.append(f'    <keybind key="C-A-W-{LOWER_KEY}"><action name="ForEach"><query {SHELL_QUERY} omnipresent="yes"/><then><action name="ToggleOmnipresent"/>'
                 f'<action name="ToggleAlwaysOnBottom"/></then></action></keybind>')
    lines.append(f'    <keybind key="C-A-W-{RAISE_KEY}"><action name="ForEach"><query {SHELL_QUERY}/><then><action name="Raise"/></then></action></keybind>')
    lines.append(f'    <keybind key="C-A-W-{OMNI_KEY}"><action name="ToggleOmnipresent"/></keybind>')
    return "\n".join(lines)
