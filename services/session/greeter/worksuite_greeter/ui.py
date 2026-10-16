"""WorkSuite greeter window (GTK 4), run by greetd inside cage as the _greetd user.

Boards: LoginUsers ("Who's signing in?" tiles), Login (avatar, name, password field), G04 (directory card),
BootSplash (the first frame). All sign-in logic is in login.py, PAM outcomes become sentences in pam_errors.py.
- Handoff from the boot splash: the first frame is the splash's last frame (veil.py) on every display; once drawn the
  greeter marks /run/worksuite/greeter/ready (greetd's ExecStartPost then lets Plymouth go) and the veil fades out.
- Tiles for the people with accounts on this computer (login.user_tiles: real accounts, AccountsService names and
  pictures, the last person first) plus "Other user" for directory accounts; one person goes straight to their tile.
- Password view: a shake and a plain sentence on failure, Caps Lock warning, a spinner while PAM works (in a thread,
  the window keeps drawing), expired passwords change here, a verification code when the account needs one.
- Corner buttons: network status, accessibility (larger text, high contrast, on-screen keyboard, screen reader),
  power (sleep, restart, shut down); the keyboard layout in the top bar.
- Several displays (cage extends over all of them): the sign-in screen on the first display, the wallpaper and clock
  on the others, each display with its own veil.
- Success: the plain veil fades in over everything, then the greeter exits and greetd starts the session, so the
  desktop follows a dark frame instead of a flash. Raw PAM text goes to the journal only.
"""
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("PangoCairo", "1.0")
gi.require_foreign("cairo")  # cairo drawing (veil, icons): python3-gi-cairo
from gi.repository import Gdk, GLib, Gtk, Pango, PangoCairo  # noqa: E402

from . import i18n  # noqa: E402
from . import login  # noqa: E402
from . import osk  # noqa: E402
from . import pam_errors  # noqa: E402
from . import veil  # noqa: E402
from .greetd import Greetd, GreetdError  # noqa: E402

_T = i18n.translation()
_ = _T.gettext
ngettext = _T.ngettext

CSS = b"""
.osk-glyph { border: 1.5px solid #FFFFFF; border-radius: 3px; padding: 2px 3px; }
.osk-glyph-key { background-color: #FFFFFF; min-width: 2px; min-height: 2px; border-radius: 1px; }
.osk-glyph-space { background-color: #FFFFFF; min-width: 12px; min-height: 2px; border-radius: 1px; }
window.ws-greeter { color: #FFFFFF; font-family: "IBM Plex Sans", sans-serif; background-color: #040A1A; }
.screen { background-color: #061029;
  background-image: radial-gradient(circle at 78% 22%, rgba(24,212,240,0.22) 0%, transparent 38%),
                    radial-gradient(circle at 18% 80%, rgba(31,107,255,0.35) 0%, transparent 45%),
                    linear-gradient(160deg, #0B2254 0%, #061029 60%, #030816 100%); }
.wall-clock { font-size: 96px; font-weight: 300; color: rgba(255,255,255,0.9); }
.wall-date { font-size: 20px; color: rgba(255,255,255,0.75); }
.topbar { font-size: 14px; color: rgba(255,255,255,0.85); }
.dot { min-width: 8px; min-height: 8px; border-radius: 4px; background: #5FD39A; }
.net-ok { color: #5FD39A; } .net-off { color: #FFB98A; }
.net-off .dot { background: #FFB98A; }
.card { background: rgba(8,20,48,0.86); border-radius: 20px; padding: 32px; border: 1px solid rgba(255,255,255,0.14); }
.card.warn { border-color: rgba(255,159,90,0.35); } .card.danger { border-color: rgba(255,138,122,0.45); }
.avatar { min-width: 72px; min-height: 72px; border-radius: 36px; background: rgba(255,255,255,0.15); font-size: 26px; font-weight: 600; }
.avatar.person { background-image: linear-gradient(135deg, #1F6BFF, #18D4F0); }
.avatar.danger { background: rgba(255,138,122,0.25); }
.avatar.big { min-width: 128px; min-height: 128px; border-radius: 64px; font-size: 46px;
  box-shadow: 0 0 0 4px rgba(255,255,255,0.14), 0 20px 50px rgba(0,0,0,0.45); }
.avatar.tile { min-width: 96px; min-height: 96px; border-radius: 48px; font-size: 34px; }
.avatar.other { background: rgba(255,255,255,0.08); }
picture.avatar-pic { border-radius: 999px; }
.title { font-size: 22px; font-weight: 700; }
.who { font-size: 30px; font-weight: 600; }
.person-name { font-size: 26px; font-weight: 600; }
.sub { font-size: 13px; color: rgba(255,255,255,0.7); }
.hint { font-size: 13px; color: rgba(255,255,255,0.6); }
.caps { font-size: 12px; color: #FFD58A; }
.field-label { font-size: 12px; color: #C9D6EE; }
entry, passwordentry, dropdown > button { min-height: 44px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.2);
  background: rgba(4,10,26,0.6); color: #FFFFFF; padding: 0 14px; box-shadow: none; outline: none; }
.pwrow { min-height: 48px; border-radius: 12px; background: rgba(8,20,48,0.6); border: 1px solid rgba(255,255,255,0.18); padding: 0 6px 0 4px; }
.pwrow.bad { border-color: #FF8A7A; }
.pwrow passwordentry, .pwrow entry { background: transparent; border: none; min-height: 46px; }
button.go { min-width: 36px; min-height: 36px; border-radius: 9px; background: #1F6BFF; color: #FFFFFF; padding: 0; border: none; box-shadow: none; }
.note { border-radius: 10px; padding: 10px 12px; font-size: 12px; color: #E8EEFA; }
.note.warn { background: rgba(255,159,90,0.1); border: 1px solid rgba(255,159,90,0.35); }
.note.danger { background: rgba(255,138,122,0.1); border: 1px solid rgba(255,138,122,0.4); }
.error { color: #FFB4A8; font-size: 13px; }
button.cta { background: #1F6BFF; color: white; border-radius: 12px; min-height: 46px; font-size: 15px; font-weight: 600; border: none; box-shadow: none; }
button.cta.danger { background: #D9452B; }
button.link { background: none; border: none; box-shadow: none; padding: 6px; min-height: 0; color: #7FB2FF; font-size: 13px; }
button.link:hover { color: #B8D4FF; }
.methods-label { font-size: 12px; color: #8FA3C8; }
button.method { min-width: 44px; min-height: 36px; border-radius: 12px; background: rgba(14,32,72,0.6); color: #E8EEFA;
  border: 1px solid rgba(127,178,255,0.18); box-shadow: none; padding: 0 12px; font-size: 13px; }
button.method:checked { background: rgba(31,107,255,0.35); border-color: #1F6BFF; }
.key-wait { font-size: 14px; color: #C9D6EE; }
button.tile { min-width: 168px; border-radius: 18px; padding: 24px 12px 20px; background: rgba(8,20,48,0.45);
  border: 1px solid rgba(255,255,255,0.1); box-shadow: none; color: #FFFFFF; }
button.tile:hover, button.tile:focus-visible { background: rgba(31,107,255,0.2); border-color: rgba(127,178,255,0.6); }
.tile-name { font-size: 16px; font-weight: 600; }
.tile-note { font-size: 12px; color: rgba(255,255,255,0.65); }
button.pill { border-radius: 12px; padding: 8px 14px 8px 8px; background: rgba(8,20,48,0.5); border: 1px solid rgba(255,255,255,0.1);
  box-shadow: none; color: #FFFFFF; font-size: 14px; }
button.corner, menubutton.corner > button { min-width: 44px; min-height: 44px; border-radius: 12px; background: rgba(8,20,48,0.5);
  border: 1px solid rgba(255,255,255,0.1); box-shadow: none; color: #FFFFFF; padding: 0; }
popover.ws > contents { background: rgba(10,24,56,0.97); border: 1px solid rgba(127,178,255,0.18); border-radius: 14px; padding: 8px; color: #E8EEFA; }
popover.ws button.item { background: none; border: none; box-shadow: none; border-radius: 10px; padding: 10px 12px; color: #E8EEFA; font-size: 14px; }
popover.ws button.item:hover { background: rgba(31,107,255,0.22); }
popover.ws .pop-title { font-size: 13px; font-weight: 600; padding: 4px 8px; }
popover.ws .pop-sub { font-size: 12px; color: #8FA3C8; padding: 0 8px 6px; }
window.hc .screen { background-image: none; background-color: #000000; }
window.hc .pwrow, window.hc entry, window.hc passwordentry, window.hc button.tile, window.hc button.corner { border: 2px solid #FFFFFF; }
window.hc .hint, window.hc .sub, window.hc .tile-note { color: #FFFFFF; }
"""

# Sentences for every way a sign-in can fail (pam_errors.KEYS and the form checks). Never PAM's own words.
ERRORS = {
    "denied": _("The user name or password is incorrect."),
    "denied_user": _("Incorrect password. Try again."),
    "error": _("Something went wrong while signing in. Try again."),
    "locked_admin": _("This account is locked. Ask your administrator to unlock it."),
    "account_expired": _("This account has expired. Ask your administrator to renew it."),
    "expired": _("Your password has expired. Enter your current password and choose a new one."),
    "weak": _("That new password isn’t allowed. Choose a longer one that’s harder to guess."),
    "not_allowed": _("This account can’t sign in on this computer. Ask your administrator."),
    "nologin": _("Signing in isn’t possible right now. Try again in a moment."),
    "offline_expired": _("This computer has been offline too long. Connect to your organization’s network to sign in."),
    "no_network": _("Can’t reach your organization’s sign-in service. Check the network connection and try again."),
    "bad_code": _("Enter the 6-digit code from your authenticator app."),
    "mismatch": _("The new passwords do not match."),
    "short": _("The new password must be at least 10 characters."),
    "unknown_domain": _("That domain is not available on this computer."),
    "invalid": _("Enter a valid user name."),
    "empty": _("Enter a user name."),
    "reason": _("Enter a reason (at least 5 characters). It is sent to the audit log."),
    "reason_failed": _("The reason could not be saved, so emergency sign-in is not possible."),
    "bad_pin": _("Enter your PIN (4 to 12 digits)."),
    "pin_denied": _("Incorrect PIN, or the PIN is locked after too many tries. Use your password."),
    "key_failed": _("The security key wasn’t accepted. Insert it, touch it when it blinks, or use your password."),
    "power_failed": _("That didn’t work. Try again, or hold the power button to turn off."),
}


def locked_text(minutes):
    return ngettext("Too many attempts. Try again in {n} minute.", "Too many attempts. Try again in {n} minutes.", minutes).format(n=minutes)


# AuthLockPin board: Sign-in options under the field.
METHOD_LABELS = {"password": _("Password"), "pin": _("PIN"), "key": _("Security key")}

# Keyboard layouts people are likely to have here (XKB names from /etc/default/keyboard).
LAYOUT_NAMES = {"us": _("English (US)"), "gb": _("English (UK)"), "lk": _("Sinhala"), "in": _("Indian"), "de": _("German"),
                "fr": _("French"), "es": _("Spanish")}

ICONS = {  # 24-unit stroke paths, as on the Login board
    "network": "M2 9a15 15 0 0 1 20 0 M5.5 12.5a10 10 0 0 1 13 0 M9 16a5 5 0 0 1 6 0",
    "offline": "M2 9a15 15 0 0 1 20 0 M5.5 12.5a10 10 0 0 1 13 0 M9 16a5 5 0 0 1 6 0 M3 3l18 18",
    "a11y": "M12 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3 M5 8l7 1.5L19 8 M12 9.5v5l-3 6 M12 14.5l3 6",
    "power": "M12 3v9 M6.3 7.3a8 8 0 1 0 11.4 0",
    "go": "M5 12h14 M13 6l6 6-6 6",
    "back": "M19 12H5 M11 6l-6 6 6 6",
    "users": "M9 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7 M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5 M16 4.5a3.5 3.5 0 0 1 0 7 M18 15c2 .6 3 2.2 3.5 5",
    "keyboard": "M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10",
}


def label(text, *classes, **kw):
    return Gtk.Label(label=text, css_classes=list(classes), wrap=True, **kw)


def set_input_purpose(entry, purpose):
    """Gtk.PasswordEntry has no input-purpose of its own (setting it raised TypeError and left a black screen at
    boot): the hint goes on the Gtk.Text inside it, or on the entry itself where it has the property."""
    if entry.find_property("input-purpose") is not None:
        entry.set_property("input-purpose", purpose)
        return
    child = entry.get_first_child()
    while child is not None:
        if child.find_property("input-purpose") is not None:
            child.set_property("input-purpose", purpose)
            return
        child = child.get_next_sibling()


def undecorate(win):
    """The greeter is the whole screen: no title bar or close button (GTK 4 draws its own under cage)."""
    win.set_decorated(False)
    win.set_deletable(False)
    win.fullscreen()


def icon(name, size=20, color=(1, 1, 1)):
    """A stroke icon from ICONS, drawn with cairo (no icon theme in the greeter)."""
    area = Gtk.DrawingArea(content_width=size, content_height=size, can_target=False, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)

    def draw(_a, cr, w, h):
        cr.scale(w / 24, h / 24)
        cr.set_source_rgb(*color)
        cr.set_line_width(2)
        cr.set_line_cap(1)
        cr.set_line_join(1)
        _path(cr, ICONS[name])
        cr.stroke()
    area.set_draw_func(draw)
    return area


def _path(cr, d):
    """Tiny SVG path subset (M L H V C A Z, absolute and relative) for ICONS."""
    import math
    import re
    toks = re.findall(r"[MLHVCAZmlhvcaz]|-?\d*\.?\d+(?:e-?\d+)?", d)
    i, cmd, x, y, sx, sy = 0, None, 0.0, 0.0, 0.0, 0.0

    def num():
        nonlocal i
        v = float(toks[i]); i += 1
        return v
    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]; i += 1
            if cmd in "zZ":
                cr.close_path(); x, y = sx, sy
                continue
        if cmd in "Mm":
            nx, ny = num(), num()
            if cmd == "m":
                nx, ny = x + nx, y + ny
            cr.move_to(nx, ny); x, y, sx, sy = nx, ny, nx, ny
            cmd = "L" if cmd == "M" else "l"
        elif cmd in "Ll":
            nx, ny = num(), num()
            if cmd == "l":
                nx, ny = x + nx, y + ny
            cr.line_to(nx, ny); x, y = nx, ny
        elif cmd in "Hh":
            nx = num(); x = x + nx if cmd == "h" else nx; cr.line_to(x, y)
        elif cmd in "Vv":
            ny = num(); y = y + ny if cmd == "v" else ny; cr.line_to(x, y)
        elif cmd in "Cc":
            pts = [num() for _k in range(6)]
            if cmd == "c":
                pts = [pts[0] + x, pts[1] + y, pts[2] + x, pts[3] + y, pts[4] + x, pts[5] + y]
            cr.curve_to(*pts)
            x, y = pts[4], pts[5]
        elif cmd in "Aa":
            rx, ry, _rot, large, sweep, nx, ny = num(), num(), num(), num(), num(), num(), num()
            if cmd == "a":
                nx, ny = x + nx, y + ny
            r = max(rx, ry, math.hypot(nx - x, ny - y) / 2)
            mx, my = (x + nx) / 2, (y + ny) / 2
            dx, dy = (nx - x) / 2, (ny - y) / 2
            dist = math.hypot(dx, dy) or 1e-9
            hgt = math.sqrt(max(0.0, r * r - dist * dist))
            sign = 1 if bool(large) != bool(sweep) else -1
            cx, cy = mx - sign * hgt * dy / dist, my + sign * hgt * dx / dist
            a0, a1 = math.atan2(y - cy, x - cx), math.atan2(ny - cy, nx - cx)
            (cr.arc if sweep else cr.arc_negative)(cx, cy, r, a0, a1)
            x, y = nx, ny
        else:
            i += 1


def keyboard_layouts(path="/etc/default/keyboard"):
    """(names, switch hint) from the system keyboard settings cage uses (wlr-env exports them as XKB_DEFAULT_*)."""
    vals = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                k, _sep, v = line.strip().partition("=")
                vals[k] = v.strip().strip('"')
    except OSError:
        pass
    codes = [c for c in (vals.get("XKBLAYOUT") or "us").split(",") if c]
    names = [LAYOUT_NAMES.get(c, c.upper()) for c in codes]
    opts = vals.get("XKBOPTIONS", "")
    hint = ""
    if len(codes) > 1:
        for opt, keys in (("grp:alt_shift_toggle", "Alt+Shift"), ("grp:win_space_toggle", "Super+Space"), ("grp:ctrl_shift_toggle", "Ctrl+Shift"),
                          ("grp:alt_space_toggle", "Alt+Space")):
            if opt in opts:
                hint = _("Switch layouts with {keys}").format(keys=keys)
    return names, hint


def network_state():
    """('connected'|'offline'|'unknown', description) from NetworkManager, without blocking the window for long."""
    try:
        out = subprocess.run(["nmcli", "-t", "-f", "TYPE,NAME", "connection", "show", "--active"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return "unknown", _("Network status unavailable")
    for line in out.splitlines():
        kind, _sep, name = line.partition(":")
        if kind.endswith("ethernet"):
            return "connected", _("Connected · Wired")
        if kind.endswith("wireless"):
            return "connected", _("Connected · Wi-Fi “{name}”").format(name=name)
    if any(line and not line.startswith("loopback") for line in out.splitlines()):
        return "connected", _("Connected")
    return "offline", _("Not connected")


def monitor_rects(display):
    """Logical rectangles of the displays, relative to the window (cage extends over all of them)."""
    rects = []
    try:
        mons = display.get_monitors()
        for i in range(mons.get_n_items()):
            g = mons.get_item(i).get_geometry()
            rects.append((g.x, g.y, g.width, g.height))
    except Exception:  # noqa: BLE001  (no monitor information: one screen filling the window)
        return []
    if not rects:
        return []
    x0, y0 = min(r[0] for r in rects), min(r[1] for r in rects)
    return [(x - x0, y - y0, w, h) for x, y, w, h in rects]


Veil = veil.build(Gtk, Pango, PangoCairo)


class Screen(Gtk.Overlay):
    """One display: the WorkSuite gradient, its content, and its veil on top."""

    def __init__(self, content=None):
        super().__init__()
        self.base = Gtk.Overlay(css_classes=["screen"], hexpand=True, vexpand=True)
        self.set_child(self.base)
        self.content = None
        self.veil = Veil(title=_("Booting…"), sub=_("Getting your workspace ready."), phase=_("Starting desktop"))
        self.add_overlay(self.veil)
        if content is not None:
            self.set_content(content)

    def set_content(self, w):
        if self.content is not None:
            self.base.set_child(None)
        self.content = w
        self.base.set_child(w)


class Greeter(Gtk.ApplicationWindow):
    def _focus_changed(self, *_a):
        w = self.get_focus()
        if isinstance(w, Gtk.Editable):
            self.typing_into = w

    def __init__(self, app, cfg=None, users=None, reachable_probe=None):
        super().__init__(application=app, title="WorkSuite", css_classes=["ws-greeter"])
        undecorate(self)
        self.cfg = login.load_config() if cfg is None else cfg
        last = login.read_last_user()
        self.users = login.user_tiles(login.users() if users is None else users, last=last)
        self.probe = reachable_probe or (lambda: login.directory_reachable(self.cfg))
        self.joined = bool(login.suffixes(self.cfg))
        self.reachable = None  # None: not joined / unknown, True, False
        if len(self.users) == 1:
            self.view = "user"
        elif self.users:
            self.view = "tiles"
        else:
            self.view = "directory"
        self.selected = 0
        self.mode = "password"  # or "change"
        self.need_code = False
        self.busy = False
        self.failures = 0
        self.kbd = None
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(self.get_display(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        osk_css = Gtk.CssProvider()
        osk_css.load_from_data(osk.CSS)
        Gtk.StyleContext.add_provider_for_display(self.get_display(), osk_css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        # Displays: the sign-in content on the first one, the wallpaper and a clock on the others.
        self.layer = Gtk.Fixed()
        self.set_child(self.layer)
        self.screens = []
        self.content = self._build_content()
        self.walls = []
        self.layout_screens()
        try:
            self.get_display().get_monitors().connect("items-changed", lambda *_a: GLib.idle_add(self.layout_screens))
        except Exception:  # noqa: BLE001
            pass
        self.connect("notify::default-width", lambda *_a: self.layout_screens())
        self.connect("notify::default-height", lambda *_a: self.layout_screens())

        self.refresh()
        self.check_directory()
        if self.joined:
            GLib.timeout_add_seconds(30, lambda: (self.check_directory(), True)[1])
        self.update_clock()
        GLib.timeout_add_seconds(5, lambda: (self.update_clock(), True)[1])
        self.update_network()
        GLib.timeout_add_seconds(15, lambda: (self.update_network(), True)[1])
        self.watch_caps_lock()
        self.connect("map", lambda *_a: GLib.timeout_add(80, self.reveal))

    # ---- displays ----
    def layout_screens(self):
        rects = monitor_rects(self.get_display())
        w, h = self.get_width() or self.get_default_size()[0], self.get_height() or self.get_default_size()[1]
        if not rects:
            rects = [(0, 0, max(w, 1), max(h, 1))]
        while len(self.screens) < len(rects):
            s = Screen()
            self.screens.append(s)
            self.layer.put(s, 0, 0)
        while len(self.screens) > len(rects):
            s = self.screens.pop()
            if s.content is self.content:
                s.set_content(None)
            self.layer.remove(s)
        for i, (s, (x, y, rw, rh)) in enumerate(zip(self.screens, rects)):
            s.set_size_request(rw, rh)
            self.layer.move(s, x, y)
            if i == 0:
                if s.content is not self.content:
                    for other in self.screens[1:]:
                        if other.content is self.content:
                            other.set_content(None)
                    s.set_content(self.content)
            elif s.content is None or s.content is self.content:
                s.set_content(self._build_wall())
        return False

    def _build_wall(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        box.date = label("", "wall-date")
        box.clock = label("", "wall-clock")
        box.append(box.date)
        box.append(box.clock)
        self.walls.append(box)
        self.update_clock()
        return box

    def veils(self):
        return [s.veil for s in self.screens]

    def reveal(self):
        """First frame drawn (the splash look-alike): let Plymouth go, then fade into the sign-in screen."""
        veil.mark_ready()
        veil.Fader(GLib, self.veils(), 1.0, 0.0, 450, done=self.focus_first)
        return False

    def focus_first(self):
        if self.view == "user":
            self.password.grab_focus()
        elif self.view == "directory":
            self.user_entry.grab_focus()

    def cover(self, title="", sub="", then=None, ms=320):
        """Plain veil (or the shutdown/restart column) over every display, then `then`."""
        for v in self.veils():
            v.set_texts(title, sub, "", show_column=bool(title))
        veil.Fader(GLib, self.veils(), 0.0, 1.0, ms, done=then)

    # ---- content ----
    def _build_content(self):
        root = Gtk.Overlay(hexpand=True, vexpand=True)
        top = Gtk.Box(spacing=16, css_classes=["topbar"], valign=Gtk.Align.START, margin_top=28, margin_start=40, margin_end=40)
        self.clock = label("", xalign=0)
        top.append(self.clock)
        org = login.org_name(self.cfg)
        self.org_label = label(_("{org} · managed device").format(org=org) if org and self.joined else (_("Managed device") if self.joined else ""),
                               xalign=0, hexpand=True)
        top.append(self.org_label)
        self.net = Gtk.Box(spacing=8, valign=Gtk.Align.CENTER, visible=False)
        self.net.append(Gtk.Box(css_classes=["dot"], valign=Gtk.Align.CENTER))
        self.net_label = label("")
        self.net.append(self.net_label)
        top.append(self.net)
        names, hint = keyboard_layouts()
        kb = Gtk.Box(spacing=6, valign=Gtk.Align.CENTER, tooltip_text=hint or None)
        kb.append(icon("keyboard", 16))
        kb_label = label(" · ".join(names))
        kb_label.update_property([Gtk.AccessibleProperty.LABEL], [_("Keyboard layout: {layouts}").format(layouts=", ".join(names))])
        kb.append(kb_label)
        top.append(kb)
        root.add_overlay(top)

        # On-screen keyboard for touch-only devices (osk.py): typed into the field that last had focus.
        self.typing_into = None
        self.connect("notify::focus-widget", self._focus_changed)
        self.osk = Gtk.Revealer(child=osk.build(Gtk, lambda: self.typing_into), valign=Gtk.Align.END,
                                transition_type=Gtk.RevealerTransitionType.SLIDE_UP)
        root.add_overlay(self.osk)

        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE, transition_duration=250,
                               halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        root.set_child(self.stack)
        self.stack.add_named(self._build_tiles(), "tiles")
        self.stack.add_named(self._build_person(), "user")
        self.stack.add_named(self._build_card(), "card")

        bl = Gtk.Box(spacing=10, halign=Gtk.Align.START, valign=Gtk.Align.END, margin_start=40, margin_bottom=32)
        self.other_pill = Gtk.Button(css_classes=["pill"])
        pill = Gtk.Box(spacing=10)
        pill.append(icon("users", 16))
        self.other_pill_label = label(_("Other user"))
        pill.append(self.other_pill_label)
        self.other_pill.set_child(pill)
        self.other_pill.connect("clicked", lambda *_a: self.pill_clicked())
        bl.append(self.other_pill)
        root.add_overlay(bl)

        br = Gtk.Box(spacing=10, halign=Gtk.Align.END, valign=Gtk.Align.END, margin_end=40, margin_bottom=32)
        self.net_button = Gtk.MenuButton(css_classes=["corner"], tooltip_text=_("Network"))
        self.net_icon_box = Gtk.Box(halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        self.net_icon_box.append(icon("network"))
        self.net_button.set_child(self.net_icon_box)
        self.net_pop_status = label("", "pop-title", xalign=0)
        self.net_pop_dir = label("", "pop-sub", xalign=0)
        self.net_button.set_popover(self._popover([self.net_pop_status, self.net_pop_dir]))
        self.net_button.update_property([Gtk.AccessibleProperty.LABEL], [_("Network")])
        br.append(self.net_button)
        br.append(self._a11y_button())
        br.append(self._power_button())
        root.add_overlay(br)
        return root

    def pill_clicked(self):
        if self.view == "user":
            self.show_view("tiles" if len(self.users) > 1 else "directory")
        else:
            self.show_view("tiles" if len(self.users) > 1 else "user", 0)

    def _popover(self, children):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        for c in children:
            box.append(c)
        return Gtk.Popover(child=box, css_classes=["ws"], has_arrow=False, position=Gtk.PositionType.TOP)

    def _a11y_button(self):
        b = Gtk.MenuButton(css_classes=["corner"], tooltip_text=_("Accessibility"))
        b.set_child(icon("a11y"))
        b.update_property([Gtk.AccessibleProperty.LABEL], [_("Accessibility")])
        rows = [label(_("Accessibility"), "pop-title", xalign=0)]

        def switch_row(text, cb, active=False):
            r = Gtk.Box(spacing=16, margin_start=8, margin_end=8, margin_top=4, margin_bottom=4)
            r.append(label(text, xalign=0, hexpand=True))
            s = Gtk.Switch(active=active, valign=Gtk.Align.CENTER)
            s.update_property([Gtk.AccessibleProperty.LABEL], [text])
            s.connect("notify::active", lambda sw, _p: cb(sw.get_active()))
            r.append(s)
            return r
        settings = Gtk.Settings.get_default()
        base_dpi = settings.get_property("gtk-xft-dpi") if settings else -1

        def large(on):
            if settings and base_dpi and base_dpi > 0:
                settings.set_property("gtk-xft-dpi", int(base_dpi * (1.25 if on else 1)))
        rows.append(switch_row(_("Larger text"), large))
        rows.append(switch_row(_("High contrast"), lambda on: (self.add_css_class if on else self.remove_css_class)("hc")))
        rows.append(switch_row(_("On-screen keyboard"), lambda on: self.osk.set_reveal_child(on)))
        if shutil.which("orca"):
            rows.append(switch_row(_("Screen reader"), self.screen_reader))
        b.set_popover(self._popover(rows))
        return b

    def screen_reader(self, on):
        if on and not getattr(self, "orca", None):
            try:
                self.orca = subprocess.Popen(["orca", "--replace"])
            except OSError:
                self.orca = None
        elif not on and getattr(self, "orca", None):
            self.orca.terminate()
            self.orca = None

    def _power_button(self):
        b = Gtk.MenuButton(css_classes=["corner"], tooltip_text=_("Power options"))
        b.set_child(icon("power"))
        b.update_property([Gtk.AccessibleProperty.LABEL], [_("Power options")])
        items = []
        for text, verb in ((_("Sleep"), "suspend"), (_("Restart"), "reboot"), (_("Shut down"), "poweroff")):
            it = Gtk.Button(label=text, css_classes=["item"])
            it.get_child().set_xalign(0)
            it.connect("clicked", lambda _b, v=verb: (b.popdown(), self.power(v)))
            items.append(it)
        b.set_popover(self._popover(items))
        return b

    def power(self, verb):
        def go():
            try:
                subprocess.Popen(["systemctl", verb])
            except OSError:
                self.show_message(ERRORS["power_failed"])
        if verb == "suspend":
            go()
        elif verb == "reboot":
            self.cover(_("Restarting…"), _("You’ll be back in a moment."), then=go, ms=300)
        else:
            self.cover(_("Shutting down…"), _("Saving settings and closing apps."), then=go, ms=300)

    def _avatar(self, user, cls):
        """The person's picture (AccountsService) or their initials."""
        size = {"big": 128, "tile": 96}[cls]
        if user and user.get("icon"):
            try:
                pic = Gtk.Picture.new_for_filename(user["icon"])
                pic.set_content_fit(Gtk.ContentFit.COVER)
                pic.set_size_request(size, size)
                pic.add_css_class("avatar-pic")
                frame = Gtk.Box(css_classes=["avatar", cls], overflow=Gtk.Overflow.HIDDEN, halign=Gtk.Align.CENTER)
                frame.append(pic)
                return frame
            except GLib.Error:
                pass
        return label(user["initials"] if user else "+", "avatar", cls, "person" if user else "other",
                     halign=Gtk.Align.CENTER, justify=Gtk.Justification.CENTER)

    def _build_tiles(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=40, halign=Gtk.Align.CENTER)
        box.append(label(_("Who’s signing in?"), "who", justify=Gtk.Justification.CENTER))
        self.tiles = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, homogeneous=True, column_spacing=28, row_spacing=28,
                                 max_children_per_line=5, halign=Gtk.Align.CENTER)
        box.append(self.tiles)
        self.fill_tiles()
        return box

    def fill_tiles(self):
        while (c := self.tiles.get_first_child()) is not None:
            self.tiles.remove(c)
        entries = [(u, (lambda i: lambda *_a: self.show_view("user", i))(i)) for i, u in enumerate(self.users)]
        entries.append((None, lambda *_a: self.show_view("directory")))
        if self.break_glass() and self.reachable is False:
            entries.append(({"initials": "!", "display": _("Emergency admin access"), "name": ""}, lambda *_a: self.show_view("breakglass")))
        per_line = min(len(entries), 5)
        self.tiles.set_min_children_per_line(per_line)
        self.tiles.set_max_children_per_line(per_line)
        for u, cb in entries:
            b = Gtk.Button(css_classes=["tile"])
            col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, halign=Gtk.Align.CENTER)
            col.append(self._avatar(u, "tile"))
            name = u["display"] if u else _("Other user")
            col.append(label(name, "tile-name", justify=Gtk.Justification.CENTER, max_width_chars=16))
            note = (_("Work account") if u and u.get("directory") else "") if u else (_("Enter a work account") if self.joined else _("Enter a user name"))
            if note:
                col.append(label(note, "tile-note", justify=Gtk.Justification.CENTER))
            b.set_child(col)
            b.update_property([Gtk.AccessibleProperty.LABEL], [name])
            b.connect("clicked", cb)
            self.tiles.append(b)

    def _build_person(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, halign=Gtk.Align.CENTER)
        self.person_avatar = Gtk.Box(halign=Gtk.Align.CENTER)
        box.append(self.person_avatar)
        self.person_name = label("", "person-name", justify=Gtk.Justification.CENTER, margin_top=6)
        box.append(self.person_name)
        self.person_sub = label("", "sub", justify=Gtk.Justification.CENTER, max_width_chars=44)
        box.append(self.person_sub)
        # The field row: password (or PIN), then the arrow; a spinner takes the arrow's place while PAM works.
        self.pwrow = Gtk.Box(spacing=4, css_classes=["pwrow"], margin_top=10, margin_start=16, margin_end=16)
        self.pwrow.set_size_request(340, 48)
        self.password = Gtk.PasswordEntry(show_peek_icon=True, hexpand=True, placeholder_text=_("Password"))
        self.password.connect("activate", lambda *_a: self.submit())
        self.password.update_property([Gtk.AccessibleProperty.LABEL], [_("Password")])
        self.pwrow.append(self.password)
        self.go = Gtk.Button(css_classes=["go"], valign=Gtk.Align.CENTER, tooltip_text=_("Sign in"))
        self.go.set_child(icon("go", 18))
        self.go.update_property([Gtk.AccessibleProperty.LABEL], [_("Sign in")])
        self.go.connect("clicked", lambda *_a: self.submit())
        self.spinner = Gtk.Spinner(spinning=False, visible=False, valign=Gtk.Align.CENTER, margin_end=8)
        self.spinner.set_size_request(20, 20)
        self.pwrow.append(self.go)
        self.pwrow.append(self.spinner)
        box.append(self.pwrow)
        # Shared form pieces (also used by the card): code, new passwords, methods, notes.
        self.form = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, halign=Gtk.Align.CENTER)
        self.form.set_size_request(340, -1)
        box.append(self.form)
        self.caps = label(_("Caps Lock is on"), "caps", justify=Gtk.Justification.CENTER, visible=False)
        box.append(self.caps)
        self.person_msg = label("", "hint", justify=Gtk.Justification.CENTER, max_width_chars=44)
        self.person_msg.update_property([Gtk.AccessibleProperty.LABEL], [_("Sign-in message")])
        box.append(self.person_msg)
        self.person_links = Gtk.Box(spacing=16, halign=Gtk.Align.CENTER)
        box.append(self.person_links)
        return box

    def _build_card(self):
        self.card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16, css_classes=["card"], halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        self.card.set_size_request(420, -1)
        head = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, halign=Gtk.Align.CENTER)
        self.avatar = label("?", "avatar", halign=Gtk.Align.CENTER, justify=Gtk.Justification.CENTER)
        self.title = label("", "title", justify=Gtk.Justification.CENTER, margin_top=4)
        self.sub = label("", "sub", justify=Gtk.Justification.CENTER, max_width_chars=40)
        for w in (self.avatar, self.title, self.sub):
            head.append(w)
        self.card.append(head)
        self.user_entry = Gtk.Entry()
        self.user_entry.connect("activate", lambda *_a: self.card_password.grab_focus())
        self.user_field = self._field(_("Work email or username"), self.user_entry)
        self.card.append(self.user_field)
        sx = login.suffixes(self.cfg)
        self.suffix = Gtk.DropDown.new_from_strings(["@" + s for s in sx]) if len(sx) > 1 else None
        if self.suffix:
            self.suffix.update_property([Gtk.AccessibleProperty.LABEL], [_("Sign-in domain")])
            self.user_field.append(self.suffix)
        self.card_password = Gtk.PasswordEntry(show_peek_icon=True)
        self.card_password.connect("activate", lambda *_a: self.submit())
        self.card_password_field = self._field(_("Password"), self.card_password)
        self.card.append(self.card_password_field)
        self.reason = Gtk.Entry()
        self.reason.connect("activate", lambda *_a: self.submit())
        self.reason_field = self._field(_("Reason (sent to the audit log)"), self.reason)
        self.card.append(self.reason_field)
        self.code = Gtk.Entry(input_purpose=Gtk.InputPurpose.DIGITS, max_length=6)
        self.code.connect("activate", lambda *_a: self.submit())
        self.code_field = self._field(_("Verification code"), self.code)
        self.new1 = Gtk.PasswordEntry(show_peek_icon=True)
        self.new1_field = self._field(_("New password"), self.new1)
        self.new2 = Gtk.PasswordEntry(show_peek_icon=True)
        self.new2.connect("activate", lambda *_a: self.submit())
        self.new2_field = self._field(_("Confirm new password"), self.new2)
        self.method = "password"
        self.key_wait = label(_("Insert your security key, choose Sign in, then touch it when it blinks."), "key-wait", justify=Gtk.Justification.CENTER,
                              max_width_chars=40, visible=False)
        self.methods = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, halign=Gtk.Align.CENTER)
        self.methods.append(label(_("Sign-in options"), "methods-label", justify=Gtk.Justification.CENTER))
        row = Gtk.Box(spacing=8, halign=Gtk.Align.CENTER)
        row.update_property([Gtk.AccessibleProperty.LABEL], [_("Sign-in method")])
        self.method_buttons = {}
        first = None
        for m in login.METHODS:
            b = Gtk.ToggleButton(label=METHOD_LABELS[m], css_classes=["method"])
            if first:
                b.set_group(first)
            first = first or b
            b.connect("toggled", lambda btn, m=m: btn.get_active() and self.pick_method(m))
            row.append(b)
            self.method_buttons[m] = b
        self.methods.append(row)
        self.note = label("", "note", xalign=0, max_width_chars=40)
        self.message = label("", "error", xalign=0, max_width_chars=40, visible=False)
        self.message.connect("notify::label", lambda m, _p: m.set_visible(bool(m.get_label())))
        self.message.update_property([Gtk.AccessibleProperty.LABEL], [_("Sign-in message")])
        self.card.append(self.note)
        self.card.append(self.message)
        self.button = Gtk.Button(label=_("Sign in"), css_classes=["cta"])
        self.button.connect("clicked", lambda *_a: self.submit())
        self.card.append(self.button)
        links = Gtk.Box()
        self.card_links = links
        self.link_a = Gtk.Button(css_classes=["link"], halign=Gtk.Align.START, hexpand=True)
        self.link_b = Gtk.Button(css_classes=["link"], halign=Gtk.Align.END)
        self.link_a.connect("clicked", lambda *_a: self.link(self.link_a.get_label()))
        self.link_b.connect("clicked", lambda *_a: self.link(self.link_b.get_label()))
        links.append(self.link_a)
        links.append(self.link_b)
        self.card.append(links)
        return self.card

    def _field(self, text, entry):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        lab = label(text, "field-label", xalign=0)
        lab.set_mnemonic_widget(entry)
        entry.update_property([Gtk.AccessibleProperty.LABEL], [text])
        box.append(lab)
        box.append(entry)
        box.label = lab
        return box

    def _move(self, w, parent):
        if w.get_parent() is not parent:
            if w.get_parent() is not None:
                w.get_parent().remove(w)
            parent.append(w)

    # ---- clock, network, directory, caps lock ----
    def update_clock(self):
        now = time.localtime()
        self.clock.set_text(time.strftime("%a %d %b · %H:%M", now))
        for w in self.walls:
            w.date.set_text(time.strftime("%A, %d %B", now))
            w.clock.set_text(time.strftime("%H:%M", now))

    def update_network(self):
        def run():
            st = network_state()
            GLib.idle_add(self.set_network, st)
        threading.Thread(target=run, daemon=True).start()

    def set_network(self, st):
        state, text = st
        self.net_pop_status.set_text(text)
        while (c := self.net_icon_box.get_first_child()) is not None:
            self.net_icon_box.remove(c)
        self.net_icon_box.append(icon("offline" if state == "offline" else "network", color=(1, 0.725, 0.541) if state == "offline" else (1, 1, 1)))
        self.net_button.update_property([Gtk.AccessibleProperty.LABEL], [_("Network: {status}").format(status=text)])
        return False

    def check_directory(self):
        if not self.joined:
            return
        def run():
            r = self.probe()
            GLib.idle_add(self.set_reachable, r)
        threading.Thread(target=run, daemon=True).start()

    def set_reachable(self, r):
        if r != self.reachable:
            self.reachable = r
            self.fill_tiles()
            self.refresh()
        return False

    def watch_caps_lock(self):
        try:
            kbd = self.get_display().get_default_seat().get_keyboard()
        except Exception:  # noqa: BLE001
            kbd = None
        self.kbd = kbd
        if kbd is not None:
            kbd.connect("notify::caps-lock-state", lambda *_a: self.update_caps())
        self.update_caps()

    def update_caps(self):
        on = bool(self.kbd and self.kbd.get_caps_lock_state())
        self.caps.set_visible(on and self.view in ("user", "directory", "breakglass") and self.method != "key")
        return False

    # ---- views ----
    def user(self):
        return self.users[self.selected] if self.users and self.view == "user" else None

    def offline_cached(self):
        u = self.user()
        return bool(u and u.get("directory") and self.reachable is False)

    def show_view(self, view, selected=None):
        if self.busy:
            return
        self.view = view
        if selected is not None:
            self.selected = selected
        self.mode, self.need_code = "password", False
        u = self.user()
        self.method = login.signin_methods(u["name"])["default"] if u else "password"
        self.show_message("")
        for e in (self.password, self.card_password, self.reason, self.code, self.new1, self.new2):
            e.set_text("")
        self.refresh()
        target = {"directory": self.user_entry, "breakglass": self.reason, "user": self.password}.get(view)
        if target is not None:
            target.grab_focus()

    def pw(self):
        """The password entry of the current view."""
        return self.password if self.view == "user" else self.card_password

    def refresh(self):
        org = login.org_name(self.cfg)
        offline = self.reachable is False
        self.net.set_visible(self.reachable is not None)
        self.net.set_css_classes(["net-off"] if offline else ["net-ok"])
        self.net_label.set_text(_("Offline · directory unreachable") if offline else _("Directory reachable"))
        self.net_pop_dir.set_text("" if self.reachable is None else self.net_label.get_text())
        self.net_pop_dir.set_visible(self.reachable is not None)

        v, u = self.view, self.user()
        self.stack.set_visible_child_name({"tiles": "tiles", "user": "user"}.get(v, "card"))
        # Password view only: the directory and break-glass cards have their own Back link.
        self.other_pill.set_visible(v == "user" and (len(self.users) > 1 or self.joined))
        self.other_pill_label.set_text(_("Switch user") if len(self.users) > 1 else _("Other user"))
        tone, note, cta, pw_label, links = None, "", _("Sign in"), _("Password"), ()
        if v == "user":
            self.set_person(u)
            sub = u["name"] if u["name"] != u["display"] else ""
            if self.offline_cached():
                tone = "warn"
                sub = _("Can’t reach the company directory. Signing in with the password cached on this device.")
                pw_label = _("Your last-used password")
                days = login.offline_days_left(u["name"])
                if days is None:
                    note = _("This account has no cached password on this device. Connect to the company network to sign in.")
                elif days == 0:
                    note = _("Offline sign-in has expired for this account. Connect to the company network to sign in.")
                else:
                    note = ngettext(
                        "Offline sign-in allowed for {n} more day. Connect to the company network before then to keep access.",
                        "Offline sign-in allowed for {n} more days. Connect to the company network before then to keep access.", days).format(n=days)
            self.person_sub.set_text(sub)
            self.person_sub.set_visible(bool(sub))
            links = ((_("Forgot password?"),) if u.get("directory") else ()) + ((_("Break-glass admin"),) if offline and self.break_glass() else ())
        elif v == "directory":
            self.avatar.set_text("?")
            self.title.set_text(_("Sign in to {org}").format(org=org) if org else _("Sign in"))
            self.sub.set_text(_("Use your company directory account.") if self.joined else _("Use your account on this computer."))
            self.user_field.label.set_text(_("Work email or username") if self.joined else _("User name"))
            links = (_("Forgot password?") if self.joined else "", _("Back") if self.users else "")
        elif v == "breakglass":
            tone = "danger"
            self.avatar.set_text("!")
            self.title.set_text(_("Emergency admin access"))
            self.sub.set_text(_("For IT only, when directory sign-in is impossible."))
            pw_label, cta = _("One-time break-glass code"), _("Unlock as local admin")
            note = (_("This sign-in is recorded and reported to {org} IT. The code works once and is replaced after use.").format(org=org) if org
                    else _("This sign-in is recorded and reported to IT. The code works once and is replaced after use."))
            links = (_("Back to normal sign-in"), _("How do I get a code?"))

        # Method switcher, code and change-password fields live under the active form.
        form = self.form if v == "user" else self.card
        choices = self.method_choices()
        if self.method not in choices:
            self.method = "password"
        method = self.method
        if method == "pin":
            pw_label = _("PIN")
        elif method == "key":
            cta = _("Sign in with security key")
        change = self.mode == "change"
        if v == "user":
            for w in (self.methods, self.key_wait, self.code_field, self.new1_field, self.new2_field, self.note, self.caps):
                self._move(w, self.form)
            self.password.set_property("placeholder-text", pw_label)
            self.password.update_property([Gtk.AccessibleProperty.LABEL], [pw_label])
            self.pwrow.set_visible(method != "key")
            self.go.set_tooltip_text(cta)
            self.person_links_set(links + ((cta,) if method == "key" else ()))
            if change:
                self.person_msg.set_text(_("Enter your current password, then choose a new one."))
        else:
            for w in (self.methods, self.key_wait, self.code_field, self.new1_field, self.new2_field, self.note, self.caps):
                self._move(w, self.card)
            prev = self.card.get_first_child()  # the head
            for w in (self.user_field, self.card_password_field, self.caps, self.reason_field, self.code_field, self.new1_field, self.new2_field,
                      self.methods, self.key_wait, self.note, self.message, self.button, self.card_links):
                self.card.reorder_child_after(w, prev)
                prev = w
            self.avatar.set_css_classes(["avatar"] + (["danger"] if v == "breakglass" else []))
            self.card.set_css_classes(["card"] + ([tone] if tone else []))
            self.user_field.set_visible(v == "directory")
            self.reason_field.set_visible(v == "breakglass")
            self.card_password_field.label.set_text(pw_label)
            self.card_password.update_property([Gtk.AccessibleProperty.LABEL], [pw_label])
            self.card_password_field.set_visible(True)
            self.button.set_label(_("Change password and sign in") if change else cta)
            self.button.set_css_classes(["cta"] + (["danger"] if v == "breakglass" else []))
            la, lb = (links + ("", ""))[:2]
            self.link_a.set_label(la)
            self.link_a.set_visible(bool(la))
            self.link_b.set_label(lb)
            self.link_b.set_visible(bool(lb))
        self.note.set_text(note)
        self.note.set_css_classes(["note", tone or "warn"])
        self.note.set_visible(bool(note))
        self.methods.set_visible(len(choices) > 1 and v == "user")
        for m, b in self.method_buttons.items():
            b.set_visible(m in choices)
            if (m == method) != b.get_active():
                b.set_active(m == method)
        self.key_wait.set_visible(method == "key" and v == "user")
        set_input_purpose(self.password, Gtk.InputPurpose.PIN if method == "pin" else Gtk.InputPurpose.PASSWORD)
        self.code_field.set_visible(self.need_code and v in ("user", "directory"))
        self.new1_field.set_visible(change)
        self.new2_field.set_visible(change)
        if form is self.form and not self.person_msg.get_text():
            self.person_msg.set_css_classes(["hint"])
            self.person_msg.set_text(_("Press Enter to sign in") if method != "key" else "")
        self.update_caps()

    def set_person(self, u):
        while (c := self.person_avatar.get_first_child()) is not None:
            self.person_avatar.remove(c)
        self.person_avatar.append(self._avatar(u, "big"))
        self.person_name.set_text(u["display"])

    def person_links_set(self, links):
        while (c := self.person_links.get_first_child()) is not None:
            self.person_links.remove(c)
        for text in links:
            if not text:
                continue
            b = Gtk.Button(label=text, css_classes=["cta"] if text == _("Sign in with security key") else ["link"])
            b.connect("clicked", lambda btn: self.submit() if btn.get_label() == _("Sign in with security key") else self.link(btn.get_label()))
            self.person_links.append(b)

    def pick_method(self, m):
        if m == self.method:
            return
        self.method = m
        self.show_message("")
        self.password.set_text("")
        self.refresh()
        if m != "key":
            self.password.grab_focus()

    def method_choices(self):
        u = self.user()
        if not u or self.offline_cached() or self.mode == "change":
            return ["password"]
        return login.available_methods(login.signin_methods(u["name"]))

    def break_glass(self):
        return login.break_glass_available()

    def link(self, text):
        org = login.org_name(self.cfg)
        if text == _("Forgot password?"):
            self.show_message(_("Ask {org} IT to reset your directory password.").format(org=org) if org else _("Ask IT to reset your directory password."), error=False)
        elif text == _("How do I get a code?"):
            self.show_message(_("IT decrypts this computer’s escrowed break-glass password with the organization’s escrow key."), error=False)
        elif text == _("Break-glass admin"):
            self.show_view("breakglass")
        elif text in (_("Back"), _("Back to normal sign-in")):
            self.show_view("tiles" if len(self.users) > 1 else ("user" if self.users else "directory"))

    # ---- messages and motion ----
    def show_message(self, text, error=True):
        if self.view == "user":
            self.person_msg.set_css_classes(["error" if error and text else "hint"])
            self.person_msg.set_text(text)
            self.pwrow.set_css_classes(["pwrow"] + (["bad"] if error and text else []))
        else:
            self.message.set_css_classes(["error"] if error else ["sub"])
            self.message.set_text(text)

    def shake(self, widget):
        """Login board's ws-shake: ±8 px, 0.4 s, damped (margins move the centred row; GTK has no negative margins)."""
        base = 16
        t0 = GLib.get_monotonic_time()

        def step():
            t = (GLib.get_monotonic_time() - t0) / 400000
            if t >= 1:
                widget.set_margin_start(base)
                widget.set_margin_end(base)
                return False
            import math
            d = int(round(8 * math.sin(t * math.pi * 4) * (1 - t)))
            widget.set_margin_start(base + d)
            widget.set_margin_end(base - d)
            return True
        GLib.timeout_add(16, step)

    def set_busy(self, on):
        self.busy = on
        self.spinner.set_visible(on)
        self.spinner.set_spinning(on)
        self.go.set_visible(not on)
        for w in (self.password, self.card_password, self.user_entry, self.code, self.new1, self.new2, self.reason, self.button, self.tiles):
            w.set_sensitive(not on)
        if on:
            self.cta_label = self.button.get_label()
            self.button.set_label(_("Signing in…"))
        elif getattr(self, "cta_label", None):
            self.button.set_label(self.cta_label)

    # ---- sign-in ----
    def target(self):
        if self.view == "user":
            return self.user()["name"]
        if self.view == "breakglass":
            return login.BREAK_GLASS_USER
        sx = login.suffixes(self.cfg)
        chosen = sx[self.suffix.get_selected()] if self.suffix else None
        return login.normalize(self.user_entry.get_text(), self.cfg, chosen)

    def fail(self, key, extra=None, params=None):
        if key == "denied" and self.view == "user" and self.method == "password":
            key = "denied_user"
        if key == "locked":
            text = locked_text((params or {}).get("minutes", 1))
        else:
            text = extra or ERRORS.get(key, ERRORS["error"])
        self.show_message(text)
        self.pw().set_text("")
        self.code.set_text("")
        self.shake(self.pwrow if self.view == "user" else self.card)
        self.pw().grab_focus()

    def submit(self):
        if self.busy:
            return
        try:
            name = self.target()
        except login.NameError_ as e:
            return self.fail(str(e))
        if self.view == "breakglass":
            if len(" ".join(self.reason.get_text().split())) < 5:
                return self.fail("reason")
            try:
                login.save_break_glass_reason(self.reason.get_text())
            except OSError:
                return self.fail("reason_failed")
        new = None
        if self.mode == "change":
            new = self.new1.get_text()
            if new != self.new2.get_text():
                return self.fail("mismatch")
            if len(new) < 10:
                return self.fail("short")
        otp = self.code.get_text().strip() if self.need_code and self.method == "password" else None
        method = self.method if self.view == "user" else "password"
        secret = "" if method == "key" else self.pw().get_text()
        directory = not login.is_local(name)
        self.set_busy(True)
        self.show_message(_("Touch your security key now.") if method == "key" else "", error=False)

        def run():
            try:
                g = Greetd()
                try:
                    r = login.sign_in(g, name, secret, otp=otp or None, new_password=new, method=method)
                finally:
                    g.close()
            except (GreetdError, OSError) as e:
                r = login.Result(False, "error", [f"greetd: {e}"])
            GLib.idle_add(self.finish, r, name, method, directory)
        threading.Thread(target=run, daemon=True).start()

    def finish(self, r, name, method, directory):
        self.set_busy(False)
        self.new1.set_text("")
        self.new2.set_text("")
        if r.ok:
            login.save_last_user(name)
            self.set_busy(True)
            self.spinner.set_visible(False)
            # Into the session: a dark frame on every display, then greetd starts it.
            self.cover(then=lambda: self.get_application().quit(), ms=350)
            return False
        print(pam_errors.journal_line(name, r.reason, r.messages), file=sys.stderr, flush=True)
        if r.reason == "mfa":
            self.need_code = True
            self.refresh()
            self.fail(None, _("Enter your password and the 6-digit code from your authenticator app."))
            return False
        if r.reason == "denied" and method == "pin":
            self.fail("pin_denied")
            return False
        if r.reason in ("key_failed", "bad_pin", "bad_code"):
            self.fail(r.reason)
            return False
        key, params = pam_errors.classify(r.reason, r.messages, directory=directory)
        if key == "expired":
            self.mode = "change"
            self.refresh()
        self.failures += 1
        self.fail(key, params=params)
        return False


def main():
    app = Gtk.Application(application_id="lk.worksuite.Greeter")
    failed = []

    def activate(a):
        # A window that fails half-way through __init__ is already attached to the application, so the main loop
        # would keep running with nothing on screen: cage shows only a pointer and the gtkgreet fallback in the
        # wrapper never starts. Any startup error therefore ends the greeter with a failure status.
        try:
            Greeter(a).present()
        except Exception:
            traceback.print_exc()
            failed.append(True)
            for w in a.get_windows():
                w.destroy()
            a.quit()

    app.connect("activate", activate)
    rc = app.run(sys.argv[:1])
    return 1 if failed else rc


if __name__ == "__main__":
    os.environ.setdefault("GDK_BACKEND", "wayland")
    GLib.set_prgname("worksuite-greeter")
    sys.exit(main())
