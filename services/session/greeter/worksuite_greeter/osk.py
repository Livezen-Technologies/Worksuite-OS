"""On-screen keyboard built into the greeter, for touch-only devices.

The greeter runs alone in cage, which has no layer-shell, so a separate keyboard (wvkbd, squeekboard) cannot be shown
there. This keyboard is part of the greeter window instead: the keyboard button at the top shows it, and its keys
type into the field that last had focus. User and domain names and passwords are typed in Latin letters; the greeter
has no input method, so there are no Sinhala or Tamil layouts here.
"""

ROWS = {
    "lower": ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"],
    "upper": ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"],
    "symbols": ["!@#$%^&*()", "-_=+[]{}\\|", ";:'\",.<>/?", "`~€£¥§"],
}
# Special keys on the last row, in order: name → label.
SPECIAL = [("shift", "⇧"), ("symbols", "?123"), ("space", " "), ("at", "@"), ("backspace", "⌫"), ("enter", "↵")]


def apply_key(text, pos, key):
    """Returns (text, pos, action) after a key: action is None, "enter", or a layout name to switch to."""
    pos = max(0, min(pos, len(text)))
    if key == "backspace":
        return (text[: pos - 1] + text[pos:], pos - 1, None) if pos else (text, pos, None)
    if key == "enter":
        return text, pos, "enter"
    if key in ("shift", "symbols"):
        return text, pos, key
    ch = {"space": " ", "at": "@"}.get(key, key)
    if len(ch) != 1:
        return text, pos, None
    return text[:pos] + ch + text[pos:], pos + 1, None


def next_layout(current, action):
    if action == "shift":
        return "lower" if current == "upper" else "upper"
    if action == "symbols":
        return "lower" if current == "symbols" else "symbols"
    return current


def build(Gtk, target):
    """A Gtk.Box with the keyboard. `target()` returns the Gtk.Editable to type into (or None)."""
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, css_classes=["osk"])
    state = {"layout": "lower"}
    rows = []

    def press(key):
        ed = target()
        if ed is None:
            return
        text, pos, action = apply_key(ed.get_text(), ed.get_position(), key)
        if action == "enter":
            ed.activate() if hasattr(ed, "activate") else None
        elif action:
            state["layout"] = next_layout(state["layout"], action)
            fill()
            return
        ed.set_text(text)
        ed.set_position(pos)

    def fill():
        for r in rows:
            box.remove(r)
        rows.clear()
        for line in ROWS[state["layout"]] + [None]:
            row = Gtk.Box(spacing=6, halign=Gtk.Align.CENTER)
            keys = [(c, c) for c in line] if line else SPECIAL
            for key, lab in keys:
                b = Gtk.Button(label=lab, css_classes=["osk-key"] + (["osk-space"] if key == "space" else []))
                b.set_focus_on_click(False)
                b.connect("clicked", lambda _b, k=key: press(k))
                row.append(b)
            rows.append(row)
            box.append(row)

    fill()
    return box


CSS = b"""
.osk { background: rgba(4,10,26,0.94); border-top: 1px solid rgba(127,178,255,0.2); padding: 12px; }
button.osk-key { min-width: 56px; min-height: 52px; border-radius: 10px; background: rgba(255,255,255,0.1);
  color: #FFFFFF; font-size: 18px; border: none; box-shadow: none; }
button.osk-key:active { background: #1F6BFF; }
button.osk-space { min-width: 280px; }
button.osk-toggle { background: rgba(255,255,255,0.08); border-radius: 10px; min-width: 44px; min-height: 44px; border: none; color: #FFFFFF; }
"""


# The toggle's keyboard glyph is drawn, not looked up: the greeter runs without an icon theme that has
# input-keyboard-symbolic (or an SVG pixbuf loader), and GTK then shows its broken-image icon.
def icon_rects(w, h):
    """Outline and keys of a keyboard glyph in a w×h box: [(x, y, width, height, filled), ...]."""
    bw, bh = w * 0.9, h * 0.62
    x0, y0 = (w - bw) / 2, (h - bh) / 2
    out = [(x0, y0, bw, bh, False)]
    kw, kh, gap = bw / 8, bh / 6, bw / 16
    for row in range(2):
        for col in range(5):
            out.append((x0 + gap + col * (kw + gap * 0.6), y0 + bh * 0.2 + row * (kh + bh * 0.12), kw, kh, True))
    out.append((x0 + bw * 0.25, y0 + bh * 0.68, bw * 0.5, kh, True))
    return out


def icon(Gtk, size=18):
    area = Gtk.DrawingArea(content_width=size, content_height=size)

    def draw(_a, cr, w, h):
        cr.set_source_rgb(1, 1, 1)
        cr.set_line_width(1.5)
        for x, y, rw, rh, filled in icon_rects(w, h):
            cr.rectangle(x, y, rw, rh)
            cr.fill() if filled else cr.stroke()
    area.set_draw_func(draw)
    return area
