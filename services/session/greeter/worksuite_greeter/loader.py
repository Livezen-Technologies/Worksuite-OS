"""The WorkSuite loader ("assemble", branding/loaders/worksuite-loader-assemble.svg) for GTK surfaces: the greeter's
handoff veil, its busy indicators and the USB updater. The same keyframes as the boot splash
(branding/plymouth/worksuite.script) and the shell (shell/src/components/WorkSuiteLoader.tsx), so the motion never
changes between splash, greeter and desktop. 2.4 s loop on the SVG's 128-unit grid: a cyan left cell slides in, a cyan
bottom cell rises, the blue square grows from its top-right corner, the navy overlap locks in, then all come apart.
"""
import math

PERIOD_S = 2.4
CYAN, BLUE, NAVY = (0.0, 0.855, 0.949), (0.039, 0.424, 1.0), (0.0, 0.094, 0.259)
# (time 0..1, value) keyframes: left/bottom "away" (1 = 28 units out and transparent), blue/navy scale.
LEFT = ((0, 1), (0.14, 0), (0.70, 0), (0.86, 1), (1, 1))
BOTTOM = ((0, 1), (0.08, 1), (0.22, 0), (0.74, 0), (0.90, 1), (1, 1))
BLUE_SCALE = ((0, 0), (0.16, 0), (0.32, 1.06), (0.38, 1), (0.66, 1), (0.82, 0), (1, 0))
NAVY_SCALE = ((0, 0), (0.34, 0), (0.44, 1), (0.62, 1), (0.72, 0), (1, 0))


def ease(x):
    """Smootherstep, close to the SVG's cubic-bezier(.5,0,.2,1)."""
    return x * x * x * (x * (x * 6 - 15) + 10)


def kf(t, frames):
    if t <= frames[0][0]:
        return frames[0][1]
    for (t0, v0), (t1, v1) in zip(frames, frames[1:]):
        if t <= t1:
            return v1 if t1 == t0 else v0 + (v1 - v0) * ease((t - t0) / (t1 - t0))
    return frames[-1][1]


def cells(seconds, reduced=False):
    """The four cells at `seconds` as (x, y, size, rgb, alpha) on the 128-unit grid. Reduced motion: the still mark."""
    t = 0.5 if reduced else (seconds % PERIOD_S) / PERIOD_S   # 0.5: every piece in place
    out = []
    off = kf(t, LEFT)
    out.append((16 - 28 * off, 48, 32, CYAN, 1 - off))
    off = kf(t, BOTTOM)
    out.append((48, 80 + 28 * off, 32, CYAN, 1 - off))
    s = kf(t, BLUE_SCALE)
    if s > 0.001:
        out.append((112 - 64 * s, 16, 64 * s, BLUE, min(1.0, s)))
    s = kf(t, NAVY_SCALE)
    if s > 0.001:
        out.append((64 - 16 * s, 64 - 16 * s, 32 * s, NAVY, s))
    return out


def draw(cr, x, y, size, seconds, alpha=1.0, reduced=False):
    """Paint the loader into a size × size box at (x, y) with cairo."""
    k = size / 128
    for cx, cy, s, rgb, a in cells(seconds, reduced):
        cr.set_source_rgba(*rgb, a * alpha)
        cr.rectangle(x + cx * k, y + cy * k, s * k, s * k)
        cr.fill()


def build(Gtk):
    """A GTK widget that plays the loader (replaces Gtk.Spinner); stops drawing when hidden or unmapped."""
    class Loader(Gtk.DrawingArea):
        def __init__(self, size=20, **kw):
            super().__init__(can_target=False, **kw)
            self.set_size_request(size, size)
            self.size, self.t, self._t0, self._tick = size, 0.0, None, None
            self.set_draw_func(lambda _a, cr, w, h: draw(cr, (w - self.size) / 2, (h - self.size) / 2, self.size, self.t, reduced=not _animations()))
            self.connect("map", lambda *_: self.start())
            self.connect("unmap", lambda *_: self.stop())

        def start(self):
            if self._tick is None:
                self._tick = self.add_tick_callback(self._on_tick)

        def stop(self):
            if self._tick is not None:
                self.remove_tick_callback(self._tick)
                self._tick, self._t0 = None, None

        def _on_tick(self, _w, clock):
            now = clock.get_frame_time()
            self._t0 = now if self._t0 is None else self._t0
            self.t = (now - self._t0) / 1e6
            self.queue_draw()
            return True

        # Gtk.Spinner's API, so call sites keep working.
        def set_spinning(self, on):
            self.start() if on else self.stop()

    def _animations():
        s = Gtk.Settings.get_default()
        return bool(s.get_property("gtk-enable-animations")) if s else True

    return Loader


__all__ = ["cells", "draw", "build", "kf", "ease", "PERIOD_S", "math"]
