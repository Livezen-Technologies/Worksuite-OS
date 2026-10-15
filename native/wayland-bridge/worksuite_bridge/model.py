"""Window and output model of the Wayland bridge: opaque handles, state flags and errors (SRS §5.2).

The Wayland backend reports compositor objects ("native" values) here; D-Bus callers only ever see handles.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from typing import Any, Callable, Hashable

# Bits of the `flags` field in ListWindows / WindowChanged.
ACTIVATED = 1
MINIMIZED = 2
MAXIMIZED = 4
FULLSCREEN = 8

# wlr-foreign-toplevel `state` enum value → flag bit.
WLR_STATE_FLAGS = {0: MAXIMIZED, 1: MINIMIZED, 2: ACTIVATED, 3: FULLSCREEN}

OPERATIONS = ("activate", "close", "minimize")


class BridgeError(Exception):
    name = "lk.worksuite.WaylandBridge1.Error.Failed"


class NotFound(BridgeError):
    """Stale or vanished handle (WSOS-SHL-003)."""
    name = "lk.worksuite.WaylandBridge1.Error.NotFound"


class NotSupported(BridgeError):
    """The running compositor does not offer this operation (WSOS-SHL-001)."""
    name = "lk.worksuite.WaylandBridge1.Error.NotSupported"


class AccessDenied(BridgeError):
    """Caller is not the shell or the panel (WSOS-SHL-004)."""
    name = "org.freedesktop.DBus.Error.AccessDenied"


def flags_from_states(states: list[int]) -> int:
    f = 0
    for s in states:
        f |= WLR_STATE_FLAGS.get(s, 0)
    return f


@dataclass
class Window:
    handle: str
    native: Any
    app_id: str = ""
    title: str = ""
    output: str = ""
    flags: int = 0

    def row(self) -> tuple[str, str, str, str, int]:
        return (self.handle, self.app_id, self.title, self.output, self.flags)


@dataclass
class Output:
    name: str
    description: str = ""
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0
    scale: float = 1.0

    def row(self) -> tuple[str, str, int, int, int, int, float]:
        return (self.name, self.description, self.x, self.y, self.width, self.height, float(self.scale))


Listener = Callable[[str, Window], None]


@dataclass
class WindowRegistry:
    """Maps compositor toplevels to random handles that are never reused (WSOS-SHL-003)."""
    new_handle: Callable[[], str] = field(default=lambda: "w" + secrets.token_hex(8))
    listeners: list[Listener] = field(default_factory=list)
    _by_handle: dict[str, Window] = field(default_factory=dict)
    _by_native: dict[Hashable, str] = field(default_factory=dict)
    _issued: set[str] = field(default_factory=set)

    def _emit(self, kind: str, w: Window) -> None:
        for fn in list(self.listeners):
            fn(kind, w)

    def add(self, native: Hashable, app_id: str, title: str, output: str = "", flags: int = 0) -> Window:
        if native in self._by_native:
            return self.update(native, app_id=app_id, title=title, output=output, flags=flags)
        h = self.new_handle()
        while h in self._issued:
            h = self.new_handle()
        self._issued.add(h)
        w = Window(h, native, app_id, title, output, flags)
        self._by_handle[h] = w
        self._by_native[native] = h
        self._emit("added", w)
        if output or flags:
            self._emit("changed", w)
        return w

    def update(self, native: Hashable, **attrs: Any) -> Window:
        w = self._by_handle[self._by_native[native]]
        changed = False
        for k, v in attrs.items():
            if v is not None and getattr(w, k) != v:
                setattr(w, k, v)
                changed = True
        if changed:
            self._emit("changed", w)
        return w

    def has_native(self, native: Hashable) -> bool:
        return native in self._by_native

    def remove(self, native: Hashable) -> None:
        h = self._by_native.pop(native, None)
        if h is None:
            return
        w = self._by_handle.pop(h)
        self._emit("removed", w)

    def get(self, handle: str) -> Window:
        try:
            return self._by_handle[handle]
        except KeyError:
            raise NotFound(f"no window {handle!r}") from None

    def list(self) -> list[Window]:
        return list(self._by_handle.values())


class Backend:
    """What the bridge needs from the compositor. `wayland.WaylandBackend` is the real one; tests use fakes."""

    def supported_operations(self) -> list[str]:
        return []

    def outputs(self) -> list[Output]:
        return []

    def activate(self, native: Any, token: str) -> None:
        raise NotSupported("activate")

    def close(self, native: Any) -> None:
        raise NotSupported("close")

    def set_minimized(self, native: Any, state: bool) -> None:
        raise NotSupported("minimize")
