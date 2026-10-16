"""WorkSuite greeter window (GTK 4), run by greetd inside cage as the _greetd user.

G04 board: a card on the WorkSuite gradient with the organization and directory status at the top.
- directory: "Work email or username" + password (user, user@domain and DOMAIN\\user are accepted, see login.py);
- an account of this computer (real accounts only, no sample data); a directory account while the directory is
  unreachable signs in with the cached password and shows the offline days left;
- break-glass: the escrowed one-time password of the local admin plus a reason sent with the audit event.
An optional verification code and the expired-password form stay as before. All sign-in logic is in login.py.
"""
import gettext
import os
import sys
import threading
import traceback

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GLib, Gtk  # noqa: E402

from . import login  # noqa: E402
from . import osk  # noqa: E402
from .greetd import Greetd, GreetdError  # noqa: E402

_ = gettext.translation("worksuite-greeter", fallback=True).gettext

CSS = b"""
.osk-glyph { border: 1.5px solid #FFFFFF; border-radius: 3px; padding: 2px 3px; }
.osk-glyph-key { background-color: #FFFFFF; min-width: 2px; min-height: 2px; border-radius: 1px; }
.osk-glyph-space { background-color: #FFFFFF; min-width: 12px; min-height: 2px; border-radius: 1px; }
window.ws-greeter { color: #FFFFFF; font-family: "IBM Plex Sans", sans-serif;
  background-color: #061029;
  background-image: radial-gradient(circle at 78% 22%, rgba(24,212,240,0.22) 0%, transparent 38%),
                    radial-gradient(circle at 18% 80%, rgba(31,107,255,0.35) 0%, transparent 45%),
                    linear-gradient(160deg, #0B2254 0%, #061029 60%, #030816 100%); }
.topbar { font-size: 14px; color: rgba(255,255,255,0.85); }
.dot { min-width: 8px; min-height: 8px; border-radius: 4px; background: #5FD39A; }
.net-ok { color: #5FD39A; } .net-off { color: #FFB98A; }
.net-off .dot { background: #FFB98A; }
.card { background: rgba(8,20,48,0.86); border-radius: 20px; padding: 32px; border: 1px solid rgba(255,255,255,0.14); }
.card.warn { border-color: rgba(255,159,90,0.35); } .card.danger { border-color: rgba(255,138,122,0.45); }
.avatar { min-width: 72px; min-height: 72px; border-radius: 36px; background: rgba(255,255,255,0.15); font-size: 26px; font-weight: 600; }
.avatar.person { background-image: linear-gradient(135deg, #1F6BFF, #18D4F0); }
.avatar.danger { background: rgba(255,138,122,0.25); }
.title { font-size: 22px; font-weight: 700; }
.sub { font-size: 13px; color: rgba(255,255,255,0.7); }
.field-label { font-size: 12px; color: #C9D6EE; }
entry, passwordentry, dropdown > button { min-height: 44px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.2);
  background: rgba(4,10,26,0.6); color: #FFFFFF; padding: 0 14px; box-shadow: none; outline: none; }
.note { border-radius: 10px; padding: 10px 12px; font-size: 12px; color: #E8EEFA; }
.note.warn { background: rgba(255,159,90,0.1); border: 1px solid rgba(255,159,90,0.35); }
.note.danger { background: rgba(255,138,122,0.1); border: 1px solid rgba(255,138,122,0.4); }
.error { color: #FF8A7A; font-size: 13px; }
button.cta { background: #1F6BFF; color: white; border-radius: 12px; min-height: 46px; font-size: 15px; font-weight: 600; border: none; box-shadow: none; }
button.cta.danger { background: #D9452B; }
button.link { background: none; border: none; box-shadow: none; padding: 0; min-height: 0; color: #7FB2FF; font-size: 12px; }
button.link:hover { color: #B8D4FF; }
.methods-label { font-size: 12px; color: #8FA3C8; }
button.method { min-width: 44px; min-height: 36px; border-radius: 12px; background: rgba(14,32,72,0.6); color: #E8EEFA;
  border: 1px solid rgba(127,178,255,0.18); box-shadow: none; padding: 0 12px; font-size: 13px; }
button.method:checked { background: rgba(31,107,255,0.35); border-color: #1F6BFF; }
.key-wait { font-size: 14px; color: #C9D6EE; }
button.account { background: rgba(4,10,26,0.45); border-radius: 12px; padding: 8px 12px; border: 1px solid rgba(255,255,255,0.12); }
.account .avatar { min-width: 36px; min-height: 36px; border-radius: 18px; font-size: 14px; }
"""

ERRORS = {
    "denied": _("The user name or password is incorrect."),
    "error": _("Sign-in failed. Try again."),
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
}

# AuthLockPin board: Sign-in options under the field.
METHOD_LABELS = {"password": _("Password"), "pin": _("PIN"), "key": _("Security key")}


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


class Greeter(Gtk.ApplicationWindow):
    def _focus_changed(self, *_a):
        w = self.get_focus()
        if isinstance(w, Gtk.Editable):
            self.typing_into = w

    def __init__(self, app, cfg=None, users=None, reachable_probe=None):
        super().__init__(application=app, title="WorkSuite", css_classes=["ws-greeter"])
        undecorate(self)
        self.cfg = login.load_config() if cfg is None else cfg
        self.users = login.users() if users is None else users
        self.probe = reachable_probe or (lambda: login.directory_reachable(self.cfg))
        self.joined = bool(login.suffixes(self.cfg))
        self.reachable = None  # None: not joined / unknown, True, False
        self.view = "directory" if self.joined or not self.users else "user"
        self.selected = 0
        self.mode = "password"  # or "change"
        self.need_code = False
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(self.get_display(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        osk_css = Gtk.CssProvider()
        osk_css.load_from_data(osk.CSS)
        Gtk.StyleContext.add_provider_for_display(self.get_display(), osk_css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        overlay = Gtk.Overlay()
        self.set_child(overlay)
        top = Gtk.Box(spacing=8, css_classes=["topbar"], valign=Gtk.Align.START, margin_top=28, margin_start=40, margin_end=40)
        org = login.org_name(self.cfg)
        self.org_label = label(_("{org} · managed device").format(org=org) if org and self.joined else (_("Managed device") if self.joined else ""), xalign=0, hexpand=True)
        top.append(self.org_label)
        self.net = Gtk.Box(spacing=8, valign=Gtk.Align.CENTER, visible=False)
        self.net.append(Gtk.Box(css_classes=["dot"], valign=Gtk.Align.CENTER))
        self.net_label = label("")
        self.net.append(self.net_label)
        top.append(self.net)
        # On-screen keyboard for touch-only devices (osk.py): typed into the field that last had focus.
        self.typing_into = None
        self.connect("notify::focus-widget", self._focus_changed)
        kbd = Gtk.Button(child=osk.icon(Gtk), tooltip_text=_("On-screen keyboard"), css_classes=["osk-toggle"], valign=Gtk.Align.CENTER)
        kbd.set_focus_on_click(False)
        kbd.update_property([Gtk.AccessibleProperty.LABEL], [_("On-screen keyboard")])
        top.append(kbd)
        overlay.add_overlay(top)
        self.osk = Gtk.Revealer(child=osk.build(Gtk, lambda: self.typing_into), valign=Gtk.Align.END,
                                transition_type=Gtk.RevealerTransitionType.SLIDE_UP)
        kbd.connect("clicked", lambda _b: self.osk.set_reveal_child(not self.osk.get_reveal_child()))
        overlay.add_overlay(self.osk)

        self.card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16, css_classes=["card"], halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        self.card.set_size_request(420, -1)
        overlay.set_child(self.card)

        head = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, halign=Gtk.Align.CENTER)
        self.avatar = label("?", "avatar", halign=Gtk.Align.CENTER, justify=Gtk.Justification.CENTER)
        self.title = label("", "title", justify=Gtk.Justification.CENTER, margin_top=4)
        self.sub = label("", "sub", justify=Gtk.Justification.CENTER, max_width_chars=40)
        for w in (self.avatar, self.title, self.sub):
            head.append(w)
        self.card.append(head)

        self.accounts = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.card.append(self.accounts)

        self.user_entry = Gtk.Entry()
        self.user_field = self._field(_("Work email or username"), self.user_entry)
        sx = login.suffixes(self.cfg)
        self.suffix = Gtk.DropDown.new_from_strings(["@" + s for s in sx]) if len(sx) > 1 else None
        if self.suffix:
            self.suffix.update_property([Gtk.AccessibleProperty.LABEL], [_("Sign-in domain")])
            self.user_field.append(self.suffix)
        self.password = Gtk.PasswordEntry(show_peek_icon=True)
        self.password.connect("activate", lambda *_a: self.submit())
        self.password_field = self._field(_("Password"), self.password)
        self.reason = Gtk.Entry()
        self.reason.connect("activate", lambda *_a: self.submit())
        self.reason_field = self._field(_("Reason (sent to the audit log)"), self.reason)
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
        self.card.append(self.key_wait)
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
        self.card.append(self.methods)
        self.note = label("", "note", xalign=0, max_width_chars=40)
        self.card.append(self.note)
        self.message = label("", "error", xalign=0, max_width_chars=40, visible=False)
        self.message.connect("notify::label", lambda m, _p: m.set_visible(bool(m.get_label())))
        self.message.update_property([Gtk.AccessibleProperty.LABEL], [_("Sign-in message")])
        self.card.append(self.message)
        self.button = Gtk.Button(label=_("Sign in"), css_classes=["cta"])
        self.button.connect("clicked", lambda *_a: self.submit())
        self.card.append(self.button)
        links = Gtk.Box()
        self.link_a = Gtk.Button(css_classes=["link"], halign=Gtk.Align.START, hexpand=True)
        self.link_b = Gtk.Button(css_classes=["link"], halign=Gtk.Align.END)
        self.link_a.connect("clicked", lambda *_a: self.link("a"))
        self.link_b.connect("clicked", lambda *_a: self.link("b"))
        links.append(self.link_a)
        links.append(self.link_b)
        self.card.append(links)

        self.refresh()
        self.check_directory()
        if self.joined:
            GLib.timeout_add_seconds(30, lambda: (self.check_directory(), True)[1])

    def _field(self, text, entry):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        lab = label(text, "field-label", xalign=0)
        lab.set_mnemonic_widget(entry)
        entry.update_property([Gtk.AccessibleProperty.LABEL], [text])
        box.append(lab)
        box.append(entry)
        box.label = lab
        self.card.append(box)
        return box

    # ---- directory status ----
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
            self.refresh()
        return False

    # ---- views ----
    def user(self):
        return self.users[self.selected] if self.users and self.view == "user" else None

    def offline_cached(self):
        u = self.user()
        return bool(u and u.get("directory") and self.reachable is False)

    def show_view(self, view, selected=None):
        self.view = view
        if selected is not None:
            self.selected = selected
        self.mode, self.need_code = "password", False
        u = self.user()
        self.method = login.signin_methods(u["name"])["default"] if u else "password"
        self.message.set_text("")
        for e in (self.password, self.reason, self.code, self.new1, self.new2):
            e.set_text("")
        self.refresh()
        (self.user_entry if view == "directory" else self.reason if view == "breakglass" else self.password).grab_focus()

    def refresh(self):
        org = login.org_name(self.cfg)
        offline = self.reachable is False
        self.net.set_visible(self.reachable is not None)
        self.net.set_css_classes(["net-off"] if offline else ["net-ok"])
        self.net_label.set_text(_("Offline · directory unreachable") if offline else _("Directory reachable"))

        v, u = self.view, self.user()
        tone = None
        note = ""
        cta = _("Sign in")
        pw_label = _("Password")
        links = ("", "")
        if v == "directory":
            avatar, title = "?", (_("Sign in to {org}").format(org=org) if org else _("Sign in"))
            sub = _("Use your company directory account.") if self.joined else _("Use your account on this computer.")
            self.user_field.label.set_text(_("Work email or username") if self.joined else _("User name"))
            links = (_("Forgot password?") if self.joined else "", _("Other sign-in options") if self.users or self.break_glass() else "")
        elif v == "user":
            avatar, title = login.initials(u["display"]), u["display"]
            sub = u["name"] if u["name"] != u["display"] else ""
            if self.offline_cached():
                tone = "warn"
                sub = _("Can’t reach the company directory. Signing in with the password cached on this device.")
                pw_label, cta = _("Your last-used password"), _("Sign in offline")
                days = login.offline_days_left(u["name"])
                if days is None:
                    note = _("This account has no cached password on this device. Connect to the company network to sign in.")
                elif days == 0:
                    note = _("Offline sign-in has expired for this account. Connect to the company network to sign in.")
                else:
                    note = gettext.translation("worksuite-greeter", fallback=True).ngettext(
                        "Offline sign-in allowed for {n} more day. Connect to the company network before then to keep access.",
                        "Offline sign-in allowed for {n} more days. Connect to the company network before then to keep access.", days).format(n=days)
            links = (_("Use a different account") if self.joined or len(self.users) > 1 else "",
                     _("Break-glass admin") if offline and self.break_glass() else (_("Other sign-in options") if len(self.users) > 1 else ""))
        elif v == "breakglass":
            tone = "danger"
            avatar, title = "!", _("Emergency admin access")
            sub = _("For IT only, when directory sign-in is impossible.")
            pw_label, cta = _("One-time break-glass code"), _("Unlock as local admin")
            note = (_("This sign-in is recorded and reported to {org} IT. The code works once and is replaced after use.").format(org=org) if org
                    else _("This sign-in is recorded and reported to IT. The code works once and is replaced after use."))
            links = (_("Back to normal sign-in"), _("How do I get a code?"))
        else:  # accounts
            avatar, title, sub = "?", _("Choose an account"), _("Accounts on this computer")
            links = (_("Back to normal sign-in") if self.joined else "", "")

        self.avatar.set_text(avatar)
        self.avatar.set_css_classes(["avatar"] + (["person"] if v == "user" else ["danger"] if v == "breakglass" else []))
        self.title.set_text(title)
        self.sub.set_text(sub)
        self.sub.set_visible(bool(sub))
        self.card.set_css_classes(["card"] + ([tone] if tone else []))
        self.note.set_text(note)
        self.note.set_css_classes(["note", tone or "warn"])
        self.note.set_visible(bool(note))
        choices = self.method_choices()
        if self.method not in choices:
            self.method = "password"
        method = self.method
        if method == "pin":
            pw_label = _("PIN")
        elif method == "key":
            cta = _("Sign in with security key")
        self.methods.set_visible(len(choices) > 1)
        for m, b in self.method_buttons.items():
            b.set_visible(m in choices)
            if (m == method) != b.get_active():
                b.set_active(m == method)
        self.key_wait.set_visible(method == "key" and v == "user")
        set_input_purpose(self.password, Gtk.InputPurpose.PIN if method == "pin" else Gtk.InputPurpose.PASSWORD)
        self.password_field.label.set_text(pw_label)
        self.password.update_property([Gtk.AccessibleProperty.LABEL], [pw_label])

        listing = v == "accounts"
        self.accounts.set_visible(listing)
        if listing:
            self.fill_accounts()
        self.user_field.set_visible(v == "directory")
        self.reason_field.set_visible(v == "breakglass")
        self.password_field.set_visible(not listing and not (v == "user" and method == "key"))
        self.code_field.set_visible(self.need_code and not listing)
        change = self.mode == "change"
        self.new1_field.set_visible(change)
        self.new2_field.set_visible(change)
        self.button.set_visible(not listing)
        self.button.set_label(_("Change password and sign in") if change else cta)
        self.button.set_css_classes(["cta"] + (["danger"] if v == "breakglass" else []))
        self.link_a.set_label(links[0])
        self.link_a.set_visible(bool(links[0]))
        self.link_b.set_label(links[1])
        self.link_b.set_visible(bool(links[1]))

    def pick_method(self, m):
        if m == self.method:
            return
        self.method = m
        self.message.set_text("")
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

    def fill_accounts(self):
        while (c := self.accounts.get_first_child()) is not None:
            self.accounts.remove(c)
        rows = [(login.initials(u["display"]), u["display"], (lambda i: lambda *_a: self.show_view("user", i))(i)) for i, u in enumerate(self.users)]
        if self.break_glass():
            rows.append(("!", _("Emergency admin access"), lambda *_a: self.show_view("breakglass")))
        for ini, name, cb in rows:
            b = Gtk.Button(css_classes=["account"])
            box = Gtk.Box(spacing=12)
            box.append(label(ini, "avatar", *(["danger"] if ini == "!" else ["person"])))
            box.append(label(name, xalign=0))
            b.set_child(box)
            b.connect("clicked", cb)
            self.accounts.append(b)

    def link(self, which):
        v = self.view
        text = (self.link_a if which == "a" else self.link_b).get_label()
        if text == _("Forgot password?"):
            org = login.org_name(self.cfg)
            self.message.set_text(_("Ask {org} IT to reset your directory password.").format(org=org) if org else _("Ask IT to reset your directory password."))
        elif text == _("How do I get a code?"):
            self.message.set_text(_("IT decrypts this computer’s escrowed break-glass password with the organization’s escrow key."))
        elif text == _("Break-glass admin"):
            self.show_view("breakglass")
        elif text == _("Other sign-in options"):
            self.show_view("accounts")
        elif text in (_("Use a different account"), _("Back to normal sign-in")):
            self.show_view("directory" if self.joined or not self.users else ("accounts" if v == "user" else "user"))

    # ---- sign-in ----
    def target(self):
        if self.view == "user":
            return self.user()["name"]
        if self.view == "breakglass":
            return login.BREAK_GLASS_USER
        sx = login.suffixes(self.cfg)
        chosen = sx[self.suffix.get_selected()] if self.suffix else None
        return login.normalize(self.user_entry.get_text(), self.cfg, chosen)

    def fail(self, key, extra=None):
        self.message.set_text(extra or ERRORS.get(key, ERRORS["error"]))
        self.password.set_text("")
        self.code.set_text("")
        self.password.grab_focus()

    def submit(self):
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
        try:
            g = Greetd()
            try:
                r = login.sign_in(g, name, "" if method == "key" else self.password.get_text(), otp=otp or None, new_password=new,
                                  method=method)
            finally:
                g.close()
        except (GreetdError, OSError):
            return self.fail("error")
        self.new1.set_text("")
        self.new2.set_text("")
        if r.ok:
            self.get_application().quit()
            return
        if r.reason == "expired":
            self.mode = "change"
            self.refresh()
            self.fail(None, _("Your password has expired. Enter your current password and choose a new one."))
        elif r.reason == "mfa":
            self.need_code = True
            self.refresh()
            self.fail(None, _("Enter your password and the 6-digit code from your authenticator app."))
        elif r.reason == "denied" and method == "pin":
            self.fail("pin_denied")
        else:
            self.fail(r.reason)


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
