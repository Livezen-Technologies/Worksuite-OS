"""WorkSuite greeter window (GTK 4), run by greetd inside cage as the _greetd user.

Shows the real accounts on this computer (no sample data), an "Other user" entry with the directory domain,
an optional verification code, and a new-password form when the directory says the password has expired.
All sign-in logic is in login.py.
"""
import gettext
import os
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GLib, Gtk  # noqa: E402

from . import login  # noqa: E402
from .greetd import Greetd, GreetdError  # noqa: E402

_ = gettext.translation("worksuite-greeter", fallback=True).gettext

CSS = b"""
window { background: #0B1120; color: #E8EEFA; }
.card { background: #111A2E; border-radius: 16px; padding: 28px; }
.title { font-size: 22px; font-weight: 600; }
.muted { color: #8FA3C8; }
.error { color: #FCA5A5; }
entry, dropdown { min-height: 40px; }
button.suggested-action { background: #0A6CFF; color: white; border-radius: 10px; min-height: 40px; }
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
}


class Greeter(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="WorkSuite")
        self.cfg = login.load_config()
        self.users = login.users()
        self.mode = "password"  # or "change"
        self.need_code = False
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(self.get_display(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, css_classes=["card"], halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        card.set_size_request(380, -1)
        card.append(Gtk.Label(label=_("Sign in to WorkSuite"), css_classes=["title"], xalign=0))

        names = [u["display"] for u in self.users] + [_("Other user")]
        self.user_list = Gtk.DropDown.new_from_strings(names)
        self.user_list.update_property([Gtk.AccessibleProperty.LABEL], [_("User")])
        self.user_list.connect("notify::selected", lambda *_a: self.refresh())
        card.append(self.user_list)

        self.other = Gtk.Entry(placeholder_text=_("User name"))
        self.other.update_property([Gtk.AccessibleProperty.LABEL], [_("User name")])
        card.append(self.other)
        label = login.domain_label(self.cfg)
        self.domain = Gtk.Label(label=_("Domain: {domain}").format(domain=label) if label else "", css_classes=["muted"], xalign=0, wrap=True)
        card.append(self.domain)
        sx = login.suffixes(self.cfg)
        self.suffix = Gtk.DropDown.new_from_strings(["@" + s for s in sx]) if len(sx) > 1 else None
        if self.suffix:
            self.suffix.update_property([Gtk.AccessibleProperty.LABEL], [_("Sign-in domain")])
            card.append(self.suffix)

        self.password = Gtk.PasswordEntry(show_peek_icon=True, placeholder_text=_("Password"))
        self.password.update_property([Gtk.AccessibleProperty.LABEL], [_("Password")])
        self.password.connect("activate", lambda *_a: self.submit())
        card.append(self.password)
        self.code = Gtk.Entry(placeholder_text=_("Verification code"), input_purpose=Gtk.InputPurpose.DIGITS, max_length=6)
        self.code.update_property([Gtk.AccessibleProperty.LABEL], [_("Verification code")])
        self.code.connect("activate", lambda *_a: self.submit())
        card.append(self.code)
        self.new1 = Gtk.PasswordEntry(show_peek_icon=True, placeholder_text=_("New password"))
        self.new1.update_property([Gtk.AccessibleProperty.LABEL], [_("New password")])
        self.new2 = Gtk.PasswordEntry(show_peek_icon=True, placeholder_text=_("Confirm new password"))
        self.new2.update_property([Gtk.AccessibleProperty.LABEL], [_("Confirm new password")])
        self.new2.connect("activate", lambda *_a: self.submit())
        card.append(self.new1)
        card.append(self.new2)

        self.message = Gtk.Label(css_classes=["error"], xalign=0, wrap=True)
        card.append(self.message)
        self.button = Gtk.Button(label=_("Sign in"), css_classes=["suggested-action"])
        self.button.connect("clicked", lambda *_a: self.submit())
        card.append(self.button)
        self.set_child(card)
        self.refresh()

    def other_selected(self):
        return self.user_list.get_selected() >= len(self.users)

    def refresh(self):
        other = self.other_selected()
        self.other.set_visible(other)
        self.domain.set_visible(other and bool(self.domain.get_label()))
        if self.suffix:
            self.suffix.set_visible(other)
        self.code.set_visible(self.need_code)
        change = self.mode == "change"
        self.new1.set_visible(change)
        self.new2.set_visible(change)
        self.button.set_label(_("Change password and sign in") if change else _("Sign in"))

    def target(self):
        if not self.other_selected():
            return self.users[self.user_list.get_selected()]["name"]
        sx = login.suffixes(self.cfg)
        chosen = sx[self.suffix.get_selected()] if self.suffix else None
        return login.normalize(self.other.get_text(), self.cfg, chosen)

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
        new = None
        if self.mode == "change":
            new = self.new1.get_text()
            if new != self.new2.get_text():
                return self.fail("mismatch")
            if len(new) < 10:
                return self.fail("short")
        otp = self.code.get_text().strip() if self.need_code else None
        try:
            g = Greetd()
            try:
                r = login.sign_in(g, name, self.password.get_text(), otp=otp or None, new_password=new)
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
        else:
            self.fail(r.reason)


def main():
    app = Gtk.Application(application_id="lk.worksuite.Greeter")
    app.connect("activate", lambda a: Greeter(a).present())
    return app.run(sys.argv[:1])


if __name__ == "__main__":
    os.environ.setdefault("GDK_BACKEND", "wayland")
    GLib.set_prgname("worksuite-greeter")
    sys.exit(main())
