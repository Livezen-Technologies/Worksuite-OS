"""The boot splash's last frame, drawn by GTK: the greeter's (and the live installer's) first frame.

Plymouth keeps its picture on screen until the greeter is up (greetd: `plymouth deactivate` before, `plymouth quit
--retain-splash` once the greeter says it has drawn, see bin/worksuite-greeter-handoff). The greeter's first frame is
this veil, which repeats branding/plymouth/worksuite.script's column at the same place and size on every display
(ring and mark, title, subtitle, a full bar, phase and version), then fades out over the sign-in screen: the handoff
reads as a cross-fade instead of a cut to black. The same veil, plain, fades in over the greeter before a session
starts and before shutdown/restart, so the next picture (the desktop, the shutdown splash) follows a dark frame.

Also a small program: `python3 -m worksuite_greeter.veil [--installer | --title T] -- CMD…` shows the veil, marks the handoff, runs
CMD (the live installer) and exits with its status; cage shows CMD's window over the veil once it maps.
"""
import math
import os
import re
import subprocess
import sys
import threading

BG = (0.016, 0.039, 0.102)          # #040A1A, the splash background
READY = os.environ.get("WORKSUITE_GREETER_READY", "/run/worksuite/greeter/ready")
THEME_SCRIPT = "/usr/share/plymouth/themes/worksuite/worksuite.script"


def splash_version(path=THEME_SCRIPT):
    """The version line the splash shows ("WorkSuite OS 1.1"), read from the installed theme."""
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r'^VERSION_S = "([^"@]*)";', f.read(), re.M)
        return m.group(1) if m else "WorkSuite OS"
    except OSError:
        return "WorkSuite OS"


def column(cx, cy):
    """Splash geometry (worksuite.script, S = 1 in logical pixels): ring top, title top, subtitle top, bar top."""
    ring_y = int(cy - 273 / 2)
    title_y = ring_y + 148
    sub_y = title_y + 47
    track_y = sub_y + 48
    return {"ring_y": ring_y, "title_y": title_y, "sub_y": sub_y, "track_y": track_y, "track_x": cx - 210}


def ease_out(p):
    p = min(1.0, max(0.0, p))
    return 1 - (1 - p) ** 3


def boot_handoff(path=None):
    """True for the first greeter since greetd started (it clears the mark, greetd.service): its veil continues the
    boot splash. A greeter after sign-out finds the mark from the earlier one; its veil says nothing ("Booting…"
    there was wrong)."""
    return not os.path.exists(path or READY)


def mark_ready(path=None):
    """Tells greeter-handoff that the first frame is on screen (it then lets Plymouth go)."""
    path = path or READY
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass


def build(Gtk, Pango, PangoCairo):
    """Veil widget class for this GTK (imported lazily so the geometry above is tested without GTK)."""

    class Veil(Gtk.DrawingArea):
        def __init__(self, title="", sub="", phase="", show_column=True, mark_only=False):
            super().__init__(hexpand=True, vexpand=True, can_target=False)
            self.title, self.sub, self.phase, self.show_column = title, sub, phase, show_column
            self.mark_only = mark_only   # the ring (spinning, see spin()) and the mark; no texts, no bar
            self.angle = 0.0
            self.version = splash_version()
            self.set_draw_func(self._draw)

        def spin(self):
            """Turns the ring's arc, like the splash's spinner, until the widget goes."""
            t0 = [None]

            def tick(_w, clock):
                now = clock.get_frame_time()
                t0[0] = now if t0[0] is None else t0[0]
                self.angle = ((now - t0[0]) / 1e6) * 2 * math.pi / 1.4   # one turn in 1.4 s
                self.queue_draw()
                return True
            self.add_tick_callback(tick)

        def set_texts(self, title, sub, phase, show_column=True):
            self.title, self.sub, self.phase, self.show_column = title, sub, phase, show_column
            self.queue_draw()

        def _text(self, cr, s, px, rgb, family, weight, x, y, anchor="left"):
            layout = PangoCairo.create_layout(cr)
            fd = Pango.FontDescription.from_string(family)
            fd.set_weight(weight)
            fd.set_absolute_size(px * Pango.SCALE)
            layout.set_font_description(fd)
            layout.set_text(s, -1)
            w, _h = layout.get_pixel_size()
            if anchor == "center":
                x -= w / 2
            elif anchor == "right":
                x -= w
            cr.set_source_rgb(*rgb)
            cr.move_to(int(x), int(y))
            PangoCairo.show_layout(cr, layout)

        def _draw(self, _area, cr, w, h):
            cr.set_source_rgb(*BG)
            cr.paint()
            if not self.show_column:
                return
            cx, cy = w / 2, h / 2
            g = column(cx, cy)
            rc = (cx, g["ring_y"] + 60)
            cr.set_line_width(4)
            cr.set_source_rgba(0.498, 0.698, 1.0, 0.12)         # ring track
            cr.arc(rc[0], rc[1], 54, 0, 2 * math.pi)
            cr.stroke()
            cr.set_source_rgb(0.094, 0.831, 0.941)              # #18D4F0 arc, a quarter turn
            cr.set_line_cap(1)
            cr.arc(rc[0], rc[1], 54, -math.pi / 2 + self.angle, self.angle)
            cr.stroke()
            mx, my = cx - 24, g["ring_y"] + 36                   # the mark, 48 px (60-unit artwork scaled 0.8)
            k = 0.8
            def rect(x, y, s, rgb):
                cr.set_source_rgb(*rgb)
                cr.rectangle(mx + x * k, my + y * k, s * k, s * k)
                cr.fill()
            rect(20, 0, 40, (0.122, 0.420, 1.0))
            rect(20, 20, 20, BG)
            rect(0, 20, 20, (0.094, 0.831, 0.941))
            rect(20, 40, 20, (0.094, 0.831, 0.941))
            if self.mark_only:
                return
            if self.title:
                self._text(cr, self.title, 28, (0.91, 0.933, 0.98), "IBM Plex Sans", Pango.Weight.MEDIUM, cx, g["title_y"], "center")
            if self.sub:
                self._text(cr, self.sub, 15, (0.561, 0.639, 0.784), "IBM Plex Sans", Pango.Weight.NORMAL, cx, g["sub_y"], "center")
            tx, ty = g["track_x"], g["track_y"]
            cr.set_source_rgba(0.498, 0.698, 1.0, 0.12)
            cr.rectangle(tx, ty, 420, 4)
            cr.fill()
            grad = __import__("cairo").LinearGradient(tx, 0, tx + 420, 0)
            grad.add_color_stop_rgb(0, 0.122, 0.420, 1.0)
            grad.add_color_stop_rgb(1, 0.094, 0.831, 0.941)
            cr.set_source(grad)
            cr.rectangle(tx, ty, 420, 4)
            cr.fill()
            if self.phase:
                self._text(cr, self.phase, 12, (0.369, 0.451, 0.612), "IBM Plex Mono", Pango.Weight.NORMAL, tx, ty + 14)
            self._text(cr, self.version, 12, (0.369, 0.451, 0.612), "IBM Plex Mono", Pango.Weight.NORMAL, tx + 420, ty + 14, "right")

    return Veil


class Fader:
    """Opacity animation on a set of widgets (GLib timeouts, ~60 Hz, eased)."""

    def __init__(self, GLib, widgets, start, end, ms, done=None):
        self.GLib, self.widgets, self.start, self.end, self.ms, self.done = GLib, list(widgets), start, end, ms, done
        self.t0 = GLib.get_monotonic_time()
        for w in self.widgets:
            w.set_visible(True)
            w.set_opacity(start)
        GLib.timeout_add(16, self._step)

    def _step(self):
        p = (self.GLib.get_monotonic_time() - self.t0) / 1000 / max(1, self.ms)
        v = self.start + (self.end - self.start) * ease_out(p)
        for w in self.widgets:
            w.set_opacity(v)
        if p < 1:
            return True
        for w in self.widgets:
            w.set_opacity(self.end)
            if self.end == 0:
                w.set_visible(False)
        if self.done:
            self.done()
        return False


SHELL_READY = "worksuite/shell-ready"   # under XDG_RUNTIME_DIR; the shell writes it on its first frame (main.ts)


def session_done(ready, started, failed):
    """The session veil goes once the shell has drawn (its mark is newer than the veil) or the shell failed."""
    try:
        if os.stat(ready).st_mtime >= started:
            return True
    except OSError:
        pass
    return failed()


def shell_failed():
    try:
        return subprocess.run(["systemctl", "--user", "is-failed", "--quiet", "worksuite-shell.service"], timeout=3, check=False).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def session_main():
    """Session start: from Labwc's first moment until the shell's first frame, the splash colour with the mark and a
    spinner on a layer-shell overlay (Labwc showed black with a pointer for a minute on slow machines). It leaves
    when the shell has drawn (SHELL_READY) or the shell's unit failed; never on a timer."""
    import time
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("PangoCairo", "1.0")
    gi.require_version("Gtk4LayerShell", "1.0")
    gi.require_foreign("cairo")
    from gi.repository import GLib, Gtk, Gtk4LayerShell as LS, Pango, PangoCairo
    started = time.time() - 1
    ready = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}", SHELL_READY)
    Veil = build(Gtk, Pango, PangoCairo)
    app = Gtk.Application(application_id="lk.worksuite.SessionVeil")

    def activate(a):
        win = Gtk.ApplicationWindow(application=a, title="WorkSuite")
        prov = Gtk.CssProvider()
        prov.load_from_data(b"window { background: transparent; }")
        Gtk.StyleContext.add_provider_for_display(win.get_display(), prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        LS.init_for_window(win)
        LS.set_namespace(win, "worksuite-veil")
        LS.set_layer(win, LS.Layer.OVERLAY)
        for e in (LS.Edge.TOP, LS.Edge.BOTTOM, LS.Edge.LEFT, LS.Edge.RIGHT):
            LS.set_anchor(win, e, True)
        LS.set_exclusive_zone(win, -1)
        LS.set_keyboard_mode(win, LS.KeyboardMode.NONE)
        v = Veil(mark_only=True)
        v.spin()
        win.set_child(v)
        win.present()
        polls = [0]

        def poll():
            polls[0] += 1
            if session_done(ready, started, shell_failed if polls[0] % 10 == 0 else (lambda: False)):
                Fader(GLib, [win], 1.0, 0.0, 300, done=a.quit)   # the whole surface: the shell shows through
                return False
            return True
        GLib.timeout_add(100, poll)

    app.connect("activate", activate)
    app.run(sys.argv[:1])
    return 0


def main(argv=None):
    """Installer start: the veil, then CMD in front of it (cage shows the newest window). --session: session_main."""
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--session"]:
        return session_main()
    title = ""
    if argv[:1] == ["--installer"]:
        from . import i18n
        title, argv = i18n.translation().gettext("Starting the installer…"), argv[1:]
    if argv[:1] == ["--title"]:
        title, argv = argv[1], argv[2:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("PangoCairo", "1.0")
    gi.require_foreign("cairo")
    from gi.repository import GLib, Gtk, Pango, PangoCairo
    Veil = build(Gtk, Pango, PangoCairo)
    app = Gtk.Application(application_id="lk.worksuite.Veil")
    status = [0]

    def activate(a):
        win = Gtk.ApplicationWindow(application=a, title="WorkSuite")
        win.set_decorated(False)
        win.fullscreen()
        win.set_child(Veil(title=title, phase=""))
        win.present()

        def first_frame():
            mark_ready()
            if argv:
                def run():
                    try:
                        status[0] = subprocess.call(argv)
                    except OSError:
                        status[0] = 127
                    GLib.idle_add(a.quit)
                threading.Thread(target=run, daemon=True).start()
            return False
        GLib.timeout_add(120, first_frame)

    app.connect("activate", activate)
    app.run(sys.argv[:1])
    return status[0]


if __name__ == "__main__":
    os.environ.setdefault("GDK_BACKEND", "wayland")
    sys.exit(main())
