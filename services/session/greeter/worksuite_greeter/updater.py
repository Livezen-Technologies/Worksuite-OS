"""Update WorkSuite OS from the live USB (boot menu › "Update WorkSuite OS", kernel flag worksuite.mode=update).

Runs as root in cage instead of the installer (live-config 2000-worksuite-installer). Everything that touches disks is
/usr/libexec/worksuite/worksuite-offline-update; this window finds the installed system and the update file through
it, asks for the disk passphrase when the system is encrypted, shows what will change, and follows the progress.

  Searching → [Unlock] → Ready (installed version → update version) → Updating (progress) → Done | Failed
  Nothing found: says what is missing (no WorkSuite OS on the disks, or no .wsupdate file) and offers to search again.
"""
import os
import subprocess
import sys
import threading

TOOL = os.environ.get("WS_OFFLINE_UPDATE", "/usr/libexec/worksuite/worksuite-offline-update")


def parse_scan(text):
    """worksuite-offline-update scan → {'systems': [(dev, version)], 'locked': [dev], 'bundles': [path]}."""
    out = {"systems": [], "locked": [], "bundles": []}
    for line in text.splitlines():
        kind, _, rest = line.partition(" ")
        if kind == "system" and " " in rest:
            dev, ver = rest.split(" ", 1)
            out["systems"].append((dev, ver.strip()))
        elif kind == "locked" and rest:
            out["locked"].append(rest.strip())
        elif kind == "bundle" and rest:
            out["bundles"].append(rest.strip())
    return out


def parse_progress(line):
    """One line of `apply`: ('progress', percent, phase) | ('done',) | ('error', message) | None."""
    line = line.strip()
    if line == "done":
        return ("done",)
    if line.startswith("error "):
        return ("error", line[6:])
    parts = line.split(" ", 2)
    if len(parts) == 3 and parts[0] == "progress" and parts[1].isdigit():
        return ("progress", min(100, int(parts[1])), parts[2])
    return None


def parse_json(text):
    import json
    try:
        v = json.loads(text.strip().splitlines()[-1]) if text.strip() else {}
        return v if isinstance(v, dict) else {}
    except (ValueError, IndexError):
        return {}


def best_bundle(checked):
    """checked: [(path, info)] where info is inspect's JSON. The newest usable bundle (dpkg version order) or None."""
    ok = [(p, i) for p, i in checked if i.get("version") and not i.get("error")]
    if not ok:
        return None
    best = ok[0]
    for cand in ok[1:]:
        r = subprocess.run(["dpkg", "--compare-versions", cand[1]["version"], "gt", best[1]["version"]])
        if r.returncode == 0:
            best = cand
    return best


def tool(*args, stdin=None):
    r = subprocess.run([TOOL, *args], input=stdin, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def main(argv=None):  # pragma: no cover - GTK window, exercised in the VM
    import gi
    gi.require_version("Gtk", "4.0")
    from gi.repository import GLib, Gtk

    from . import i18n
    from .ui import CSS, label, undecorate

    _ = i18n.translation().gettext

    phases = {
        "opening": _("Opening the installed system…"), "verifying": _("Checking the update’s signature…"),
        "checking": _("Checking the packages…"), "installing": _("Installing the update…"),
        "bootloader": _("Updating the boot menu…"), "done": _("Finishing…"),
    }

    class Updater(Gtk.ApplicationWindow):
        def __init__(self, app):
            super().__init__(application=app, title=_("Update WorkSuite OS"))
            undecorate(self)
            self.add_css_class("ws-greeter")
            provider = Gtk.CssProvider()
            provider.load_from_data(CSS)
            Gtk.StyleContext.add_provider_for_display(self.get_display(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
            screen = Gtk.CenterBox(orientation=Gtk.Orientation.VERTICAL)
            screen.add_css_class("screen")
            self.card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
            self.card.add_css_class("card")
            self.card.set_size_request(520, -1)
            screen.set_center_widget(self.card)
            self.set_child(screen)
            self.fullscreen()
            self.target = None
            self.search()

        # ---- building blocks ----
        def show(self, title, body=None, *widgets, cls=None):
            child = self.card.get_first_child()
            while child:
                nxt = child.get_next_sibling()
                self.card.remove(child)
                child = nxt
            for c in ("warn", "danger"):
                self.card.remove_css_class(c)
            if cls:
                self.card.add_css_class(cls)
            self.card.append(label(_("Update WorkSuite OS"), "sub", xalign=0))
            self.card.append(label(title, "title", xalign=0, wrap=True))
            if body:
                self.card.append(label(body, "hint", xalign=0, wrap=True))
            for w in widgets:
                self.card.append(w)

        def buttons(self, *specs):
            row = Gtk.Box(spacing=10, halign=Gtk.Align.END)
            row.set_margin_top(10)
            for text, cb, primary in specs:
                b = Gtk.Button(label=text)
                b.add_css_class("suggested-action" if primary else "flat")
                b.connect("clicked", lambda _b, f=cb: f())
                row.append(b)
            return row

        def power(self, verb):
            subprocess.run(["systemctl", verb])

        def background(self, work, done):
            def run():
                res = work()
                GLib.idle_add(lambda: (done(res), False)[1])
            threading.Thread(target=run, daemon=True).start()

        # ---- steps ----
        def search(self):
            spinner = Gtk.Spinner(spinning=True, halign=Gtk.Align.START)
            self.show(_("Looking for WorkSuite OS and update files…"), None, spinner)
            self.background(lambda: tool("scan"), self.found)

        def found(self, res):
            found = parse_scan(res[1])
            if not found["systems"] and found["locked"]:
                return self.unlock(found["locked"][0])
            if not found["systems"]:
                return self.nothing(_("No WorkSuite OS was found on this computer’s disks."))
            if not found["bundles"]:
                return self.nothing(_("No update file was found. Copy a .wsupdate file to the top level of a USB drive, plug it in and search again."))
            self.target = found["systems"][0]
            dev = self.target[0]
            self.show(_("Checking the update…"), None, Gtk.Spinner(spinning=True, halign=Gtk.Align.START))
            self.background(lambda: [(p, parse_json(tool("inspect", "--target", dev, "--bundle", p)[1])) for p in found["bundles"]],
                            self.checked)

        def nothing(self, why):
            self.show(_("There’s nothing to update"), why, self.buttons(
                (_("Shut down"), lambda: self.power("poweroff"), False), (_("Search again"), self.search, True)), cls="warn")

        def unlock(self, dev):
            entry = Gtk.PasswordEntry(show_peek_icon=True)
            err = label("", "caps", xalign=0)

            def go():
                pw = entry.get_text()
                if not pw:
                    return
                self.show(_("Unlocking…"), None, Gtk.Spinner(spinning=True, halign=Gtk.Align.START))
                self.background(lambda: tool("unlock", dev, stdin=pw + "\n"), lambda r: self.search() if r[0] == 0 else again())

            def again():
                self.unlock(dev)
                self._err.set_text(_("That passphrase didn’t work. Try again."))

            entry.connect("activate", lambda _e: go())
            self._err = err
            self.show(_("Your disk is encrypted"), _("Enter the disk passphrase you chose when WorkSuite OS was installed."),
                      label(_("Disk passphrase"), "field-label", xalign=0), entry, err,
                      self.buttons((_("Shut down"), lambda: self.power("poweroff"), False), (_("Unlock"), go, True)))
            entry.grab_focus()

        def checked(self, checked):
            best = best_bundle(checked)
            if not best:
                why = next((i.get("error") for _p, i in checked if i.get("error")), "")
                return self.nothing(_("The update file can’t be used: {error}").format(error=why or "?"))
            path, info = best
            dev, installed = self.target
            facts = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
            facts.append(label(_("Installed: WorkSuite OS {version}").format(version=installed), "sub", xalign=0))
            facts.append(label(_("Update: WorkSuite OS {version} ({count} packages)").format(version=info["version"], count=info.get("packages", 0)), "sub", xalign=0))
            facts.append(label(os.path.basename(path), "hint", xalign=0))
            self.show(_("Update WorkSuite OS to {version}?").format(version=info["version"]),
                      _("Your files, accounts, settings and apps stay as they are. Keep the computer plugged in; the update can’t be stopped once it starts."),
                      facts, self.buttons((_("Shut down"), lambda: self.power("poweroff"), False),
                                          (_("Update now"), lambda: self.apply(dev, path, info["version"]), True)))

        def apply(self, dev, path, version):
            bar = Gtk.ProgressBar(show_text=True)
            phase = label(phases["opening"], "hint", xalign=0)
            self.show(_("Updating WorkSuite OS…"), _("Don’t turn off the computer or remove the USB drive."), bar, phase)
            result = {"error": None, "done": False}

            def run():
                p = subprocess.Popen([TOOL, "apply", "--target", dev, "--bundle", path], stdout=subprocess.PIPE, text=True)
                for line in p.stdout:
                    ev = parse_progress(line)
                    if not ev:
                        continue
                    if ev[0] == "progress":
                        GLib.idle_add(lambda e=ev: (bar.set_fraction(e[1] / 100), bar.set_text(f"{e[1]} %"), phase.set_text(phases.get(e[2], e[2])), False)[-1])
                    elif ev[0] == "done":
                        result["done"] = True
                    else:
                        result["error"] = ev[1]
                p.wait()
                if p.returncode != 0 and not result["error"]:
                    result["error"] = _("The update tool stopped unexpectedly.")
                GLib.idle_add(lambda: (self.finished(version, result), False)[1])

            threading.Thread(target=run, daemon=True).start()

        def finished(self, version, result):
            if result["done"] and not result["error"]:
                self.show(_("WorkSuite OS is updated"), _("Updated to {version}. Remove the USB drive, then restart.").format(version=version),
                          self.buttons((_("Shut down"), lambda: self.power("poweroff"), False), (_("Restart"), lambda: self.power("reboot"), True)))
            else:
                self.show(_("The update didn’t finish"), result["error"],
                          label(_("Start the computer normally. If it doesn’t start, choose WorkSuite Recovery in its start menu."), "hint", xalign=0, wrap=True),
                          self.buttons((_("Shut down"), lambda: self.power("poweroff"), False), (_("Restart"), lambda: self.power("reboot"), True)),
                          cls="danger")

    app = Gtk.Application(application_id="lk.worksuite.OfflineUpdate")
    app.connect("activate", lambda a: Updater(a).present())
    return app.run([sys.argv[0]])


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
