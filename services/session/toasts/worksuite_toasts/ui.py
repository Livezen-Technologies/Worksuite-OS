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
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Gtk4LayerShell as LS  # noqa: E402

from .model import OSD_MS, TIMEOUT_MS, Osd, Stack, Toast, parse  # noqa: E402

CSS = b"""
window, window.background { background-color: transparent; box-shadow: none; }
.card { background: rgba(10,24,56,0.96); border: 1px solid rgba(127,178,255,0.2); border-radius: 16px; padding: 14px;
        color: #E8EEFA; }
.card:hover { background: rgba(16,36,79,0.98); }
.title { font-weight: 600; font-size: 14px; }
.body { color: #C9D6EE; font-size: 13px; }
.mark { border-radius: 10px; min-width: 40px; min-height: 40px; color: white; font-weight: 700; }
.ok { background: #1F6BFF; } .warn { background: #D98A1F; } .error { background: #D9452B; }
.osd { background: rgba(10,24,56,0.96); border: 1px solid rgba(127,178,255,0.2); border-radius: 16px; padding: 12px 16px;
       color: #E8EEFA; font-size: 13px; }
.osd progressbar trough { min-height: 6px; border-radius: 3px; background: rgba(255,255,255,0.15); }
.osd progressbar progress { min-height: 6px; border-radius: 3px; background: #1F6BFF; }
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
        # Hover keeps the toasts: their timers stop while the pointer is over them and start again (full time) when
        # it leaves. On the window, which outlives the cards render() rebuilds.
        self.hovered = False
        hover = Gtk.EventControllerMotion()
        hover.connect("enter", lambda *_a: self._hover(True))
        hover.connect("leave", lambda *_a: self._hover(False))
        self.add_controller(hover)

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

    def _hover(self, on: bool) -> None:
        self.hovered = on
        for t in self.stack.items:
            self._untime(t.key)
            if not on and not t.sticky:
                self._time(t.key)

    def _time(self, key: str) -> None:
        if not self.hovered:
            self.timers[key] = GLib.timeout_add(TIMEOUT_MS, self._expire, key)

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
                self._time(t.key)
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


OSD_LABELS = {"volume": "Volume", "mic": "Microphone", "brightness": "Brightness"}


class OsdWindow(Gtk.ApplicationWindow):
    """The level after a Fn key (#62): bottom centre on the active output, over every window, never focused.

    Created and mapped once, when the helper starts, and never unmapped: the level is shown and hidden by fading the
    card, and the surface takes no input (empty input region), so it never covers a click. A surface first mapped (or
    mapped again) only when a key was pressed showed over the desktop but not over the app windows in the VM run
    (Labwc 0.8.3); one that stays on the overlay layer from the start is above every window, also full-screen ones.
    """

    def __init__(self, app: Gtk.Application):
        super().__init__(application=app, title="WorkSuite level")
        LS.init_for_window(self)
        LS.set_namespace(self, "worksuite-osd")
        LS.set_layer(self, LS.Layer.OVERLAY)
        LS.set_anchor(self, LS.Edge.BOTTOM, True)
        LS.set_margin(self, LS.Edge.BOTTOM, 96)
        LS.set_exclusive_zone(self, 0)
        LS.set_keyboard_mode(self, LS.KeyboardMode.NONE)
        row = Gtk.Box(spacing=12)
        row.add_css_class("osd")
        row.set_size_request(260, -1)
        row.set_can_target(False)
        self.name = Gtk.Label(xalign=0, width_chars=11)
        self.bar = Gtk.ProgressBar(hexpand=True, valign=Gtk.Align.CENTER)
        self.text = Gtk.Label(xalign=1, width_chars=5)
        for w in (self.name, self.bar, self.text):
            row.append(w)
        self.row = row
        row.set_opacity(0)
        self.set_child(row)
        self.connect("realize", lambda *_a: self._no_input())
        self.timer = 0

    def _no_input(self) -> None:
        try:
            import cairo
            surface = self.get_surface()
            if surface is not None:
                surface.set_input_region(cairo.Region())   # clicks go to the window below
        except Exception:  # no gi-cairo: the 260 px card area takes clicks while mapped
            pass

    def show_level(self, o: Osd) -> None:
        self.name.set_label(OSD_LABELS.get(o.kind, o.kind))
        self.bar.set_fraction(0 if o.muted else o.value / 100)
        self.text.set_label("Muted" if o.muted else f"{o.value}%")
        self.row.set_opacity(1)
        if not self.get_visible():
            self.present()
        if self.timer:
            GLib.source_remove(self.timer)
        self.timer = GLib.timeout_add(OSD_MS, self._hide)

    def _hide(self) -> bool:
        self.timer = 0
        self.row.set_opacity(0)   # stays mapped (see the class comment)
        return False


def run() -> int:  # pragma: no cover - needs a compositor
    # NON_UNIQUE: each shell feeds its own helper through a pipe. A unique application would hand its "activate" to a
    # helper already on the bus (left by an earlier shell, or one per output) and exit 0 at once, and every toast the
    # shell then wrote went nowhere: no toast over the apps, although a worksuite_toasts process was running.
    app = Gtk.Application(application_id="lk.worksuite.Toasts", flags=Gio.ApplicationFlags.NON_UNIQUE)
    state: dict = {"buf": b""}

    def activate(a):
        prov = Gtk.CssProvider()
        prov.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        w = ToastWindow(a)
        state["w"] = w
        # The level indicator's surface is mapped now, on the overlay layer, and stays (#62).
        state["osd"] = OsdWindow(a)
        state["osd"].present()
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
                if cmd is not None and cmd[0] == "osd":
                    state["osd"].show_level(cmd[1])
                elif cmd is not None:
                    w.apply(cmd)
            return True

        GLib.io_add_watch(0, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, readable)

    app.connect("activate", activate)
    return app.run([])
