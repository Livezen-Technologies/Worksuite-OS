"""Labwc side: wlr-foreign-toplevel-management (window list, activate, close, minimize) and wl_output.

Protocol bindings are generated at build time by pywayland-scanner into `worksuite_bridge/protocol/`
(see Makefile). The bridge never touches window contents; it only relays the compositor's toplevel list.
"""
from __future__ import annotations

import asyncio
import logging
import struct
from typing import Any, Callable

from pywayland.client import Display

from .model import OPERATIONS, Backend, Output, WindowRegistry, flags_from_states

log = logging.getLogger("worksuite-bridge")


def _states(raw: Any) -> list[int]:
    if isinstance(raw, (bytes, bytearray, memoryview)):
        b = bytes(raw)
        return list(struct.unpack(f"={len(b) // 4}I", b[: len(b) // 4 * 4]))
    return [int(x) for x in raw]


class _Toplevel:
    def __init__(self) -> None:
        self.app_id = ""
        self.title = ""
        self.outputs: list[Any] = []
        self.flags = 0
        self.closed = False


class WaylandBackend(Backend):
    def __init__(self, registry: WindowRegistry, on_outputs_changed: Callable[[], None] = lambda: None, display_name: str | None = None, panel_height: int = 0):
        from .protocol import wayland as wl  # generated
        from .protocol import wlr_foreign_toplevel_management_unstable_v1 as wlr  # generated
        self._wl, self._wlr = wl, wlr
        self.registry = registry
        self.on_outputs_changed = on_outputs_changed
        self.display = Display(display_name)
        self.manager = None
        self.seat = None
        self.compositor = self.shm = self.layer_shell = None
        self.panel_height = panel_height
        self.reserver: Any = None
        self._outputs: dict[int, tuple[Any, Output]] = {}
        self._tops: dict[int, _Toplevel] = {}

    # ---- setup -----------------------------------------------------------------------------------------
    def connect(self) -> None:
        self.display.connect()
        reg = self.display.get_registry()
        reg.dispatcher["global"] = self._global
        reg.dispatcher["global_remove"] = self._global_remove
        self._registry_proxy = reg
        self.display.roundtrip()
        self.display.roundtrip()
        if self.manager is None:
            log.warning("compositor does not offer zwlr_foreign_toplevel_manager_v1; window operations unsupported")
        if self.panel_height > 0:
            if None in (self.compositor, self.shm, self.layer_shell):
                log.warning("compositor does not offer wlr-layer-shell; panel edge not reserved")
            else:
                from .layer import PanelReserver
                self.reserver = PanelReserver(self.compositor, self.shm, self.layer_shell, self.panel_height, self.display.flush)
                for key, (o, _info) in self._outputs.items():
                    self.reserver.add(key, o)
                self.display.roundtrip()

    def disconnect(self) -> None:
        """Drops every proxy before the display goes away (pywayland proxies must not outlive it)."""
        import gc
        if self.reserver is not None:
            self.reserver.clear()
        self.reserver = None
        self.manager = self.seat = self.compositor = self.shm = self.layer_shell = None
        self._outputs.clear()
        self._tops.clear()
        self._registry_proxy = None
        for w in self.registry.list():
            self.registry.remove(w.native)
        gc.collect()
        self.display.disconnect()

    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        loop.add_reader(self.display.get_fd(), self._readable)
        self.display.flush()

    def _readable(self) -> None:
        if self.display.dispatch(block=True) == -1:
            raise SystemExit("Wayland connection lost")
        self.display.flush()

    def _global(self, reg: Any, name: int, interface: str, version: int) -> None:
        wl, wlr = self._wl, self._wlr
        if interface == "zwlr_foreign_toplevel_manager_v1" and self.manager is None:
            self.manager = reg.bind(name, wlr.ZwlrForeignToplevelManagerV1, min(version, 3))
            self.manager.dispatcher["toplevel"] = self._new_toplevel
            self.manager.dispatcher["finished"] = lambda *_: setattr(self, "manager", None)
        elif interface == "wl_seat" and self.seat is None:
            self.seat = reg.bind(name, wl.WlSeat, min(version, 1))
        elif interface == "wl_compositor" and self.compositor is None:
            self.compositor = reg.bind(name, wl.WlCompositor, min(version, 4))
        elif interface == "wl_shm" and self.shm is None:
            self.shm = reg.bind(name, wl.WlShm, 1)
        elif interface == "zwlr_layer_shell_v1" and self.layer_shell is None:
            from .protocol import wlr_layer_shell_unstable_v1 as ls  # generated
            self.layer_shell = reg.bind(name, ls.ZwlrLayerShellV1, min(version, 3))
        elif interface == "wl_output":
            o = reg.bind(name, wl.WlOutput, min(version, 4))
            info = Output(name=f"output-{name}")
            self._outputs[name] = (o, info)

            def geometry(_p: Any, x: int, y: int, *_rest: Any) -> None:
                info.x, info.y = x, y

            def mode(_p: Any, flags: int, w: int, h: int, refresh: int) -> None:
                if flags & 1:  # current mode
                    info.width, info.height = w, h
                    info.refresh = refresh / 1000.0

            o.dispatcher["geometry"] = geometry
            o.dispatcher["mode"] = mode
            o.dispatcher["scale"] = lambda _p, s: setattr(info, "scale", float(s))
            o.dispatcher["name"] = lambda _p, n: setattr(info, "name", n)
            o.dispatcher["description"] = lambda _p, d: setattr(info, "description", d)
            o.dispatcher["done"] = lambda _p: self.on_outputs_changed()
            if self.reserver is not None:  # hotplug: reserve the panel edge on the new monitor (DSK-007)
                self.reserver.add(name, o)

    def _global_remove(self, _reg: Any, name: int) -> None:
        if self.reserver is not None:
            self.reserver.remove(name)
        gone = self._outputs.pop(name, None)
        if gone is not None:
            for t in self._tops.values():
                if gone[0] in t.outputs:  # windows Labwc moved off the unplugged monitor are listed on their new one
                    t.outputs.remove(gone[0])
            self.on_outputs_changed()  # DSK-007: the shell re-reads outputs and moves its panel/launcher

    def _output_name(self, proxy: Any) -> str:
        for o, info in self._outputs.values():
            if o is proxy or getattr(o, "_ptr", None) == getattr(proxy, "_ptr", 0):
                return info.name
        return ""

    # ---- toplevels -------------------------------------------------------------------------------------
    def _new_toplevel(self, _mgr: Any, handle: Any) -> None:
        t = _Toplevel()
        self._tops[id(handle)] = t
        handle.dispatcher["title"] = lambda _h, s: setattr(t, "title", s)
        handle.dispatcher["app_id"] = lambda _h, s: setattr(t, "app_id", s)
        handle.dispatcher["output_enter"] = lambda _h, o: t.outputs.append(o)
        handle.dispatcher["output_leave"] = lambda _h, o: t.outputs.remove(o) if o in t.outputs else None
        handle.dispatcher["state"] = lambda _h, raw: setattr(t, "flags", flags_from_states(_states(raw)))
        handle.dispatcher["done"] = lambda h: self._done(h, t)
        handle.dispatcher["closed"] = lambda h: self._closed(h, t)

    def _done(self, handle: Any, t: _Toplevel) -> None:
        out = next((n for n in map(self._output_name, t.outputs) if n), "")
        if self.registry.has_native(handle):
            self.registry.update(handle, app_id=t.app_id, title=t.title, output=out, flags=t.flags)
        else:
            self.registry.add(handle, t.app_id, t.title, out, t.flags)

    def _closed(self, handle: Any, t: _Toplevel) -> None:
        t.closed = True
        self.registry.remove(handle)
        self._tops.pop(id(handle), None)
        handle.destroy()
        self.display.flush()

    # ---- Backend ---------------------------------------------------------------------------------------
    def supported_operations(self) -> list[str]:
        if self.manager is None:
            return []
        return [op for op in OPERATIONS if op != "activate" or self.seat is not None]

    def outputs(self) -> list[Output]:
        return [info for _o, info in self._outputs.values()]

    def activate(self, native: Any, token: str) -> None:
        # wlr-foreign-toplevel carries no xdg-activation token; Labwc treats the request as coming from the
        # panel. Only verified shell/panel callers reach this (WSOS-SHL-002/004).
        native.activate(self.seat)
        self.display.flush()

    def close(self, native: Any) -> None:
        native.close()
        self.display.flush()

    def set_minimized(self, native: Any, state: bool) -> None:
        native.set_minimized() if state else native.unset_minimized()
        self.display.flush()

