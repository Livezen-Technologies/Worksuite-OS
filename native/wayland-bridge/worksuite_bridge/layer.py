"""Per-output panel reservation (WSOS-DSK-005/007).

For every wl_output the bridge maps a transparent, input-less wlr-layer-shell surface on the `bottom` layer,
anchored to the bottom edge with an exclusive zone of the panel height. Labwc then shrinks each output's usable
area, so maximised and snapped windows, and new windows' size and placement, stop above the shell's taskbar on every
monitor. This is the only reservation of the taskbar's edge (#53): rc.xml has no <margin bottom>, which added to it.
The height is the taskbar's (52 px, 64 in touch mode); the shell sets it with SetPanelHeight when touch mode changes. When an output goes away its
surface is destroyed and Labwc re-arranges (and moves windows off the removed output); a new output gets a
new surface. The surfaces draw nothing: the taskbar itself is the shell's per-output Electron panel window.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Callable

log = logging.getLogger("worksuite-bridge")

NAMESPACE = "worksuite-panel"
ANCHOR_BOTTOM_LR = 2 | 4 | 8  # bottom | left | right (zwlr_layer_surface_v1.anchor)
LAYER_BOTTOM = 1
SHM_ARGB8888 = 0


class _Reservation:
    def __init__(self) -> None:
        self.surface: Any = None
        self.layer: Any = None
        self.pool: Any = None
        self.buffer: Any = None
        self.width = 0
        self.height = 0
        self.configured = False


class PanelReserver:
    """Owns one reservation per output global. `height` is the panel height in logical pixels."""

    def __init__(self, compositor: Any, shm: Any, layer_shell: Any, height: int, flush: Callable[[], None]):
        from .protocol import wlr_layer_shell_unstable_v1 as ls  # generated
        self._ls = ls
        self.compositor, self.shm, self.layer_shell = compositor, shm, layer_shell
        self.height = height
        self.flush = flush
        self._res: dict[Any, _Reservation] = {}

    def reserved(self) -> dict[Any, tuple[int, int]]:
        """Configured (width, height) per output key, for tests and diagnostics."""
        return {k: (r.width, r.height) for k, r in self._res.items() if r.configured}

    def set_height(self, height: int, outputs: dict[Any, Any]) -> None:
        """A new panel height for every output (touch mode); 0 drops the reservations. `outputs`: key → wl_output,
        for the outputs to reserve when there were no reservations before."""
        height = max(0, int(height))
        if height == self.height:
            return
        self.height = height
        if height <= 0:
            self.clear()
            return
        for key, output in outputs.items():
            r = self._res.get(key)
            if r is None:
                self.add(key, output)
                continue
            r.layer.set_size(0, height)
            r.layer.set_exclusive_zone(height)
            r.surface.commit()  # the compositor answers with a configure of the new size
        self.flush()

    def add(self, key: Any, output: Any) -> None:
        if key in self._res or self.height <= 0:
            return
        r = _Reservation()
        r.surface = self.compositor.create_surface()
        empty = self.compositor.create_region()
        r.surface.set_input_region(empty)  # clicks fall through to the panel window
        empty.destroy()
        r.layer = self.layer_shell.get_layer_surface(r.surface, output, LAYER_BOTTOM, NAMESPACE)
        r.layer.set_anchor(ANCHOR_BOTTOM_LR)
        r.layer.set_size(0, self.height)
        r.layer.set_exclusive_zone(self.height)
        r.layer.set_keyboard_interactivity(0)
        r.layer.dispatcher["configure"] = lambda lay, serial, w, h: self._configure(r, lay, serial, w, h)
        r.layer.dispatcher["closed"] = lambda _lay: self.remove(key)
        r.surface.commit()
        self._res[key] = r
        self.flush()

    def _configure(self, r: _Reservation, layer: Any, serial: int, w: int, h: int) -> None:
        layer.ack_configure(serial)
        w, h = max(1, w), max(1, h or self.height)
        if (w, h) != (r.width, r.height) or r.buffer is None:
            self._drop_buffer(r)
            size = w * h * 4
            fd = os.memfd_create("worksuite-panel", os.MFD_CLOEXEC)
            try:
                os.ftruncate(fd, size)  # zero-filled ARGB = fully transparent
                r.pool = self.shm.create_pool(fd, size)
            finally:
                os.close(fd)
            r.buffer = r.pool.create_buffer(0, w, h, w * 4, SHM_ARGB8888)
            r.width, r.height = w, h
        r.surface.attach(r.buffer, 0, 0)
        r.surface.damage(0, 0, w, h)
        r.surface.commit()
        r.configured = True
        self.flush()

    @staticmethod
    def _drop_buffer(r: _Reservation) -> None:
        if r.buffer is not None:
            r.buffer.destroy()
            r.buffer = None
        if r.pool is not None:
            r.pool.destroy()
            r.pool = None

    def remove(self, key: Any) -> None:
        r = self._res.pop(key, None)
        if r is None:
            return
        try:
            r.layer.destroy()
            r.surface.destroy()
            self._drop_buffer(r)
        except Exception:  # output already gone: the compositor dropped the objects
            log.debug("reservation teardown", exc_info=True)
        self.flush()

    def clear(self) -> None:
        for k in list(self._res):
            self.remove(k)

