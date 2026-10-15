"""Minimal xdg-shell client for the headless Labwc tests: maps fullscreen windows on a named output, the way
the shell's per-monitor desktop/panel windows are placed (Chromium sends xdg_toplevel.set_fullscreen(output))."""
import gc
import os

from pywayland.client import Display

from worksuite_bridge.protocol import wayland as wl
from worksuite_bridge.protocol import xdg_shell as xs


class FullscreenClient:
    def __init__(self, display_name: str):
        self.d = Display(display_name)
        self.d.connect()
        self.g = {}
        self.outputs = {}
        self._keep = []
        reg = self.d.get_registry()
        reg.dispatcher["global"] = self._global
        self._reg = reg
        self.d.roundtrip()
        self.d.roundtrip()

    def _global(self, reg, name, iface, _ver):
        if iface == "wl_compositor":
            self.g["comp"] = reg.bind(name, wl.WlCompositor, 4)
        elif iface == "wl_shm":
            self.g["shm"] = reg.bind(name, wl.WlShm, 1)
        elif iface == "xdg_wm_base":
            self.g["wm"] = reg.bind(name, xs.XdgWmBase, 1)
            self.g["wm"].dispatcher["ping"] = lambda wm, serial: wm.pong(serial)
        elif iface == "wl_output":
            o = reg.bind(name, wl.WlOutput, 4)
            o.dispatcher["name"] = lambda _p, n, o=o: self.outputs.__setitem__(n, o)

    def fullscreen_on(self, output: str, title: str) -> None:
        s = self.g["comp"].create_surface()
        xsurf = self.g["wm"].get_xdg_surface(s)
        top = xsurf.get_toplevel()
        top.set_title(title)
        top.set_app_id("ws-test-panel")
        top.set_fullscreen(self.outputs[output])

        def configure(x, serial):
            x.ack_configure(serial)
            size = 64 * 64 * 4
            fd = os.memfd_create("ws-test")
            os.ftruncate(fd, size)
            pool = self.g["shm"].create_pool(fd, size)
            os.close(fd)
            buf = pool.create_buffer(0, 64, 64, 256, 0)
            s.attach(buf, 0, 0)
            s.commit()
            self._keep.append((pool, buf))
        xsurf.dispatcher["configure"] = configure
        s.commit()
        self._keep.append((s, xsurf, top))
        self.d.flush()

    def pump(self) -> None:
        self.d.roundtrip()

    def close(self) -> None:
        self._keep.clear()
        self.g.clear()
        self.outputs.clear()
        self._reg = None
        gc.collect()
        self.d.disconnect()
