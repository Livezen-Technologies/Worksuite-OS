"""GTK 4 window on a wlr-layer-shell surface (gtk4-layer-shell), drawn from engine.Keyboard (board OSKeyboard).

Docked: bottom edge, full width, on the overlay layer with an exclusive zone so the app is not covered. Split: the
same with the two halves at the sides. Floating: 60 % wide, moved by dragging the handle (layer-shell margins).
Top bar: emoji, clipboard, suggestions, layout (full/split/floating), hide.
"""
from __future__ import annotations

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")
from gi.repository import GLib, Gtk, Gtk4LayerShell as LS  # noqa: E402

from .engine import Keyboard  # noqa: E402
from .geometry import HEIGHT, docked, panel_height  # noqa: E402
from .layouts import Key  # noqa: E402
from .output import Output  # noqa: E402

CSS = b"""
window.wsosk { background: rgba(7,19,48,0.97); color: #E8EEFA; font-family: "IBM Plex Sans"; }
.wsosk button.k { background: rgba(127,178,255,0.16); border: none; border-radius: 10px; min-height: 52px; font-size: 20px; color: #E8EEFA; box-shadow: 0 1px 0 rgba(0,0,0,0.4); }
.wsosk button.k.sp { background: rgba(127,178,255,0.07); font-size: 15px; }
.wsosk button.k.go { background: #1F6BFF; }
.wsosk button.k:active { background: #2A4A8F; }
.wsosk button.bar { background: none; border: none; color: #C9D6EE; min-height: 36px; font-size: 16px; }
.wsosk button.sugg { background: none; border: none; color: #C9D6EE; font-size: 16px; padding: 4px 22px; }
.wsosk button.sugg.first { color: #FFFFFF; font-weight: 600; }
.wsosk .handle { background: rgba(127,178,255,0.35); min-height: 4px; min-width: 40px; border-radius: 2px; }
"""


class OskWindow(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application, kb: Keyboard, out: Output, size: str = "medium", kiosk: bool = False):
        super().__init__(application=app)
        self.kb, self.out, self.size, self.kiosk = kb, out, size, kiosk
        self.add_css_class("wsosk")
        prov = Gtk.CssProvider()
        prov.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(self.get_display(), prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        LS.init_for_window(self)
        LS.set_namespace(self, "worksuite-osk")
        LS.set_keyboard_mode(self, LS.KeyboardMode.NONE)   # never takes focus from the app being typed into
        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin_top=8, margin_bottom=14, margin_start=20, margin_end=20)
        self.set_child(self.box)
        self.drag = Gtk.GestureDrag()
        self.drag.connect("drag-update", self._dragged)
        self.panel = panel_height(kiosk)
        self.float_pos = [0, self.panel]
        self.zone = 0
        self.connect("map", self._mapped)
        self.connect("unmap", lambda *_: LS.set_exclusive_zone(self, 0))
        self.place()
        self.render()

    def _mapped(self, *_a) -> None:
        # Layer-shell applies the exclusive zone on the surface's first (buffer-less) commit, so a maximised app was
        # shrunk while the keyboard had nothing drawn yet: an empty strip, then the keys. Map with no zone and reserve
        # the space once the first frame is on screen.
        LS.set_exclusive_zone(self, 0)
        clock = self.get_frame_clock()
        if clock is None:
            LS.set_exclusive_zone(self, self.zone)
            return
        hid = [0]

        def painted(c):
            c.disconnect(hid[0])
            if self.get_mapped():
                LS.set_exclusive_zone(self, self.zone)
        hid[0] = clock.connect("after-paint", painted)

    def place(self) -> None:
        floating = self.kb.mode == "floating"
        # Overlay, docked too: Labwc hides the top layer while a full-screen window is on top, and the shell's window
        # is one whenever it is lifted over the apps (launcher, Settings…): a top-layer keyboard vanished then.
        LS.set_layer(self, LS.Layer.OVERLAY)
        for edge in (LS.Edge.LEFT, LS.Edge.RIGHT):
            LS.set_anchor(self, edge, not floating)
        LS.set_anchor(self, LS.Edge.BOTTOM, True)
        # On the taskbar, not over it (geometry.py).
        margin, zone = docked(self.size, self.panel)
        LS.set_margin(self, LS.Edge.BOTTOM, int(self.float_pos[1]) if floating else margin)
        self.zone = 0 if floating else zone
        # Before the first frame (_mapped) the zone stays 0.
        LS.set_exclusive_zone(self, self.zone if self.get_mapped() else 0)
        self.set_default_size(int(self.get_display().get_monitors()[0].get_geometry().width * 0.6) if floating else -1, HEIGHT[self.size])

    def _dragged(self, _g, dx: float, dy: float) -> None:
        LS.set_margin(self, LS.Edge.BOTTOM, max(0, int(self.float_pos[1] - dy)))
        LS.set_anchor(self, LS.Edge.LEFT, True)
        LS.set_margin(self, LS.Edge.LEFT, max(0, int(self.float_pos[0] + dx)))

    def _btn(self, k: Key) -> Gtk.Button:
        b = Gtk.Button(label=k.label or " ")
        b.add_css_class("k")
        if k.special:
            b.add_css_class("sp")
        if k.action == "key:Return":
            b.add_css_class("go")
        b.set_hexpand(True)
        b.set_size_request(int(48 * k.width), -1)
        b.update_property([Gtk.AccessibleProperty.LABEL], [k.label or "space"])
        b.connect("clicked", lambda _b, key=k: self.press(key))
        return b

    def press(self, k: Key) -> None:
        self.out.apply(self.kb.press(k))
        self.render()

    def render(self) -> None:
        while (c := self.box.get_first_child()) is not None:
            self.box.remove(c)
        if self.kb.mode == "floating":
            h = Gtk.Box(halign=Gtk.Align.CENTER)
            h.add_css_class("handle")
            h.add_controller(self.drag)
            self.box.append(h)
        bar = Gtk.Box(spacing=6)
        for label, action in (("☺", "emoji"), ("📋", "clipboard")):
            b = Gtk.Button(label=label)
            b.add_css_class("bar")
            b.connect("clicked", lambda _b, a=action: self.press(Key("", a)))
            bar.append(b)
        sugg = Gtk.Box(spacing=2, hexpand=True, halign=Gtk.Align.CENTER)
        for i, w in enumerate(self.kb.suggestions()):
            b = Gtk.Button(label=w)
            b.add_css_class("sugg")
            if i == 0:
                b.add_css_class("first")
            b.connect("clicked", lambda _b, word=w: (self.out.apply(self.kb.pick(word)), self.render()))
            sugg.append(b)
        bar.append(sugg)
        for label, action in (("⌨ " + self.kb.mode, "mode"), ("⌄", "hide")):
            if self.kiosk and action == "hide":
                continue
            b = Gtk.Button(label=label)
            b.add_css_class("bar")
            b.connect("clicked", lambda _b, a=action: self._bar(a))
            bar.append(b)
        self.box.append(bar)
        halves = Gtk.Box(spacing=180 if len(self.kb.halves()) > 1 else 0, homogeneous=len(self.kb.halves()) > 1)
        for half in self.kb.halves():
            col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, hexpand=True)
            for row in half:
                r = Gtk.Box(spacing=7, homogeneous=False)
                for k in row:
                    r.append(self._btn(k))
                col.append(r)
            halves.append(col)
        self.box.append(halves)

    def _bar(self, action: str) -> None:
        self.out.apply(self.kb.press(Key("", action)))
        if action == "mode":
            self.zone = 0
        self.connect("map", self._mapped)
        self.connect("unmap", lambda *_: LS.set_exclusive_zone(self, 0))
        self.place()
        self.render()

    def _mapped(self, *_a) -> None:
        # Layer-shell applies the exclusive zone on the surface's first (buffer-less) commit, so a maximised app was
        # shrunk while the keyboard had nothing drawn yet: an empty strip, then the keys. Map with no zone and reserve
        # the space once the first frame is on screen.
        LS.set_exclusive_zone(self, 0)
        clock = self.get_frame_clock()
        if clock is None:
            LS.set_exclusive_zone(self, self.zone)
            return
        hid = [0]

        def painted(c):
            c.disconnect(hid[0])
            if self.get_mapped():
                LS.set_exclusive_zone(self, self.zone)
        hid[0] = clock.connect("after-paint", painted)


def run(kb: Keyboard, size: str, kiosk: bool, control_path: str) -> int:  # pragma: no cover - needs a compositor
    import os
    import socket

    import sys

    from .control import parse, state_line

    app = Gtk.Application(application_id="lk.worksuite.Osk")
    state: dict = {}

    def activate(a):
        out = Output(on_hide=lambda: state["w"].set_visible(False))
        w = OskWindow(a, kb, out, size, kiosk)
        state["w"] = w

        def report(*_a):
            # The shell follows the keyboard's real state (also after its own hide key).
            try:
                sys.stdout.write(state_line(w.get_visible()))
                sys.stdout.flush()
            except OSError:
                pass
        w.connect("notify::visible", report)
        w.set_visible(kiosk)
        try:
            os.unlink(control_path)
        except FileNotFoundError:
            pass
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        srv.bind(control_path)
        os.umask(old)
        srv.listen(4)

        def on_conn(_src, _cond):
            c, _ = srv.accept()
            c.settimeout(1)
            try:
                for line in c.makefile().read(512).splitlines():
                    cmd = parse(line)
                    if cmd is None:
                        continue
                    if cmd[0] == "show":
                        kb.set_field(cmd[1], cmd[2])
                        w.render()
                        w.set_visible(True)
                    elif cmd[0] == "hide" and not kiosk:
                        w.set_visible(False)
                    elif cmd[0] == "toggle":
                        w.set_visible(kiosk or not w.get_visible())
            except OSError:
                pass
            finally:
                c.close()
            return True

        GLib.io_add_watch(srv.fileno(), GLib.IO_IN, on_conn)
        state["srv"] = srv

    app.connect("activate", activate)
    return app.run([])
