"""Toast cards on a wlr-layer-shell OVERLAY surface (gtk4-layer-shell), anchored top-right.

The shell's own window is always below the apps (Labwc rc.xml), so its in-window toasts never showed over Firefox.
A layer surface on the overlay layer is above every window and every full-screen one, on all desktops. It is only as
big as the cards (anchored top and right, natural size), so the rest of the screen stays clickable; it takes no
keyboard focus. With no output set, Labwc puts it on the active output; it is unmapped while empty and mapped again for
the next toast, so each burst shows where the user is.
"""
from __future__ import annotations

import os
import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")
from gi.repository import Gdk, GLib, Gtk, Gtk4LayerShell as LS  # noqa: E402

from .model import TIMEOUT_MS, Stack, Toast, parse  # noqa: E402

CSS = b"""
window, window.background { background-color: transparent; box-shadow: none; }
.card { background: rgba(10,24,56,0.96); border: 1px solid rgba(127,178,255,0.2); border-radius: 16px; padding: 14px;
        color: #E8EEFA; }
.card:hover { background: rgba(16,36,79,0.98); }
.title { font-weight: 600; font-size: 14px; }
.body { color: #C9D6EE; font-size: 13px; }
.mark { border-radius: 10px; min-width: 40px; min-height: 40px; color: white; font-weight: 700; }
.ok { background: #1F6BFF; } .warn { background: #D98A1F; } .error { background: #D9452B; }
.x { background: transparent; border: none; color: #8FA3C8; min-width: 24px; min-height: 24px; padding: 0; }
"""


def emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


class ToastWindow(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application):
        super().__init__(application=app, title="WorkSuite toasts")
        LS.init_for_window(self)
        LS.set_namespace(self, "worksuite-toasts")
        LS.set_layer(self, LS.Layer.OVERLAY)
        LS.set_anchor(self, LS.Edge.TOP, True)
        LS.set_anchor(self, LS.Edge.RIGHT, True)
        LS.set_margin(self, LS.Edge.TOP, 16)
        LS.set_margin(self, LS.Edge.RIGHT, 16)
        LS.set_exclusive_zone(self, 0)
        LS.set_keyboard_mode(self, LS.KeyboardMode.NONE)
        self.set_default_size(380, -1)
        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.box.set_size_request(380, -1)
        self.set_child(self.box)
        self.stack = Stack()
        self.timers: dict[str, int] = {}

    def render(self) -> None:
        while (c := self.box.get_first_child()) is not None:
            self.box.remove(c)
        for t in self.stack.items:
            self.box.append(self._card(t))
        if self.stack.items:
            self.set_default_size(380, 1)   # shrink to the cards
            self.set_visible(True)
        else:
            self.set_visible(False)

    def _card(self, t: Toast) -> Gtk.Widget:
        row = Gtk.Box(spacing=12)
        row.add_css_class("card")
        # Only files: the shell resolves icon names (no theme lookups here, see tests/test_osk.py).
        mark = Gtk.Image.new_from_file(t.icon) if t.icon.startswith("/") else None
        if mark is not None:
            mark.set_pixel_size(40)
        else:
            mark = Gtk.Label(label="✓" if t.tone == "ok" else "!")
            mark.add_css_class("mark")
            mark.add_css_class(t.tone)
        mark.set_valign(Gtk.Align.START)
        row.append(mark)
        col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3, hexpand=True)
        for text, cls in ((t.title, "title"), (t.body, "body")):
            if text.strip():
                lab = Gtk.Label(label=text, xalign=0, wrap=True, max_width_chars=40)
                lab.add_css_class(cls)
                col.append(lab)
        row.append(col)
        close = Gtk.Button(label="✕", valign=Gtk.Align.START)
        close.add_css_class("x")
        close.connect("clicked", lambda _b: self.close_toast(t.key))
        row.append(close)
        click = Gtk.GestureClick()
        click.connect("released", lambda g, _n, x, y: self._clicked(g, t.key, close, x, y))
        row.add_controller(click)
        row.set_cursor(Gdk.Cursor.new_from_name("pointer"))
        return row

    def _clicked(self, g: Gtk.GestureClick, key: str, close: Gtk.Widget, x: float, y: float) -> None:
        w = g.get_widget()
        if w.pick(x, y, Gtk.PickFlags.DEFAULT) in (close, close.get_first_child()):
            return
        emit(f"click {key}")
        self.stack.hide(key)
        self._untime(key)
        self.render()

    def close_toast(self, key: str) -> None:
        if self.stack.hide(key):
            emit(f"closed {key}")
        self._untime(key)
        self.render()

    def _untime(self, key: str) -> None:
        if key in self.timers:
            GLib.source_remove(self.timers.pop(key))

    def apply(self, cmd: tuple[str, object]) -> None:
        op, arg = cmd
        if op == "show":
            t = arg  # type: ignore[assignment]
            self._untime(t.key)
            for d in self.stack.show(t):
                self._untime(d.key)
                emit(f"closed {d.key}")
            if not t.sticky:
                self.timers[t.key] = GLib.timeout_add(TIMEOUT_MS, self._expire, t.key)
        elif op == "hide":
            self.stack.hide(str(arg))
            self._untime(str(arg))
        else:
            for d in self.stack.clear():
                self._untime(d.key)
        self.render()

    def _expire(self, key: str) -> bool:
        self.timers.pop(key, None)
        if self.stack.hide(key):
            emit(f"closed {key}")
            self.render()
        return False


def run() -> int:  # pragma: no cover - needs a compositor
    app = Gtk.Application(application_id="lk.worksuite.Toasts")
    state: dict = {"buf": b""}

    def activate(a):
        prov = Gtk.CssProvider()
        prov.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        w = ToastWindow(a)
        state["w"] = w
        a.hold()

        def readable(fd, cond):
            if cond & (GLib.IO_HUP | GLib.IO_ERR):
                data = os.read(fd, 65536) if cond & GLib.IO_IN else b""
                if not data:
                    a.quit()   # the shell went away
                    return False
            else:
                data = os.read(fd, 65536)
                if not data:
                    a.quit()
                    return False
            state["buf"] += data
            *lines, state["buf"] = state["buf"].split(b"\n")
            state["buf"] = state["buf"][-65536:]
            for line in lines:
                cmd = parse(line.decode("utf-8", "replace"))
                if cmd is not None:
                    w.apply(cmd)
            return True

        GLib.io_add_watch(0, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, readable)

    app.connect("activate", activate)
    return app.run([])
