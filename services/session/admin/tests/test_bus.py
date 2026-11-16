"""lk.worksuite.Admin1 (WSOS-ARC-002): allow-listed arguments, one polkit action per method, the caller's UID from the
bus only, the fixed helpers with argument arrays and a clean environment. Polkit and the helpers are mocked."""
import asyncio
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from worksuite_admin import bus  # noqa: E402

ROOT = HERE.parents[2]


class Harness:
    def __init__(self, verdicts=None, codes=None, out="out\n", err="err\n"):
        self.verdicts = list(verdicts or [])
        self.codes = list(codes or [0])
        self.out, self.err = out, err
        self.asked, self.runs = [], []

    async def authorize(self, action):
        self.asked.append(action)
        return self.verdicts.pop(0) if self.verdicts else "yes"

    async def run(self, argv, stdin, env):
        self.runs.append((argv, stdin, env))
        return (self.codes.pop(0) if self.codes else 0), self.out, self.err


class AdminBusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self.tmp.name, "vda"))

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, member, args, uid=1000, h=None, exists=lambda p: True):
        h = h or Harness()
        r = asyncio.run(bus.dispatch(member, args, uid, h.authorize, h.run, exists, self.tmp.name))
        return r, h

    # ---- validation ----
    def bad(self, member, args):
        with self.assertRaises(bus.InvalidArgs, msg=f"{member} {args!r}"):
            bus.validate(member, args, self.tmp.name)

    def test_unknown_methods_and_arity_are_refused(self):
        self.bad("RunCommand", ["id"])
        self.bad("ForcePower", [])
        self.bad("ForcePower", ["reboot", "x"])
        self.bad("Journal", ["boot"])
        self.bad("KioskExit", "pin")

    def test_kiosk_exit_arguments(self):
        c = bus.validate("KioskExit", ["pin", "482915"])
        self.assertEqual((c.action, c.argv, c.stdin), ("lk.worksuite.kiosk.exit-pin", [bus.KIOSK_EXIT, "--pin"], b"482915\n"))
        c = bus.validate("KioskExit", ["admin", ""])
        self.assertEqual((c.action, c.argv, c.stdin), ("lk.worksuite.kiosk.exit-admin", [bus.KIOSK_EXIT, "--admin"], b""))
        for a in (["pin", ""], ["pin", "12"], ["pin", "12ab56"], ["pin", "1234\n5678"], ["pin", "1" * 13], ["admin", "1234"], ["--admin", ""], ["root", ""]):
            self.bad("KioskExit", a)

    def test_reinstall_options_are_an_allow_list(self):
        c = bus.validate("Reinstall", [{"mode": "keep", "disk": "vda"}], self.tmp.name)
        self.assertEqual((c.action, c.argv), ("lk.worksuite.recovery.reinstall", [bus.REINSTALL, "--mode", "keep", "--disk", "vda"]))
        c = bus.validate("Reinstall", [{"mode": "erase", "disk": "vda", "confirm": "vda"}], self.tmp.name)
        self.assertEqual(c.argv, [bus.REINSTALL, "--mode", "erase", "--disk", "vda", "--confirm", "vda"])
        for o in ({"mode": "erase", "disk": "vda"}, {"mode": "erase", "disk": "vda", "confirm": "vdb"},
                  {"mode": "keep", "disk": "vda", "confirm": "vda"}, {"mode": "keep", "disk": "vda", "source": "/tmp/x.squashfs"},
                  {"mode": "keep", "disk": "vda", "target-dir": "/"}, {"mode": "keep", "disk": "vda", "no-bootloader": ""},
                  {"mode": "wipe", "disk": "vda"}, {"mode": "keep"}, {"disk": "vda"}, {"mode": "keep", "disk": "sdz"},
                  {"mode": "keep", "disk": "../vda"}, {"mode": "keep", "disk": "-vda"}, {"mode": "keep", "disk": "vda;id"}):
            self.bad("Reinstall", [o])
        self.bad("Reinstall", ["keep"])

    def test_printer_arguments(self):
        ok = [["devices"], ["drivers", "id", "MFG:Brother;MDL:HL;"], ["drivers", "mm", "Brother HL"],
              ["add", "Brother_HL", "usb://Brother/HL?serial=1", "everywhere", "Brother HL"], ["remove", "Brother_HL"],
              ["pause", "Office-1"], ["resume", "Office-1"]]
        for a in ok:
            c = bus.validate("Printers", [a])
            self.assertEqual((c.action, c.argv), ("lk.worksuite.printers", [bus.PRINTER_ADMIN, *a]))
        self.assertTrue(bus.validate("Printers", [["devices"]]).output)
        self.assertFalse(bus.validate("Printers", [["remove", "P"]]).output)
        for a in ([], ["devices", "x"], ["drivers", "path", "x"], ["drivers", "id", ""], ["drivers", "id", "a\nb"],
                  ["add", "P", "u", "d"], ["add", "-P", "usb://x", "everywhere", "P"], ["add", "P", "usb://x\n", "everywhere", "P"],
                  ["remove", "a b"], ["remove", "--all"], ["remove"], ["lpadmin", "-x", "P"], [1]):
            self.bad("Printers", [a])

    def test_power_and_diagnostics_arguments(self):
        self.assertEqual(bus.validate("ForcePower", ["poweroff"]).argv, [bus.POWER_FORCE, "poweroff"])
        self.assertEqual(bus.validate("Journal", ["greeter", 200]).argv, [bus.DIAGNOSTICS, "journal", "greeter", "200"])
        self.assertEqual(bus.validate("BootDetails", ["on"]).argv, [bus.DIAGNOSTICS, "boot-details", "on"])
        for m, a in (("ForcePower", ["suspend"]), ("ForcePower", ["reboot;id"]), ("Journal", ["all", 10]), ("Journal", ["boot", 0]),
                     ("Journal", ["boot", 5001]), ("Journal", ["boot", "5"]), ("Journal", ["boot", True]), ("BootDetails", ["status"])):
            self.bad(m, a)

    # ---- handlers ----
    def test_each_method_checks_its_own_action_then_runs_the_helper(self):
        cases = [
            ("KioskExit", ["admin", ""], "lk.worksuite.kiosk.exit-admin"),
            ("Reinstall", [{"mode": "keep", "disk": "vda"}], "lk.worksuite.recovery.reinstall"),
            ("Printers", [["devices"]], "lk.worksuite.printers"),
            ("ForcePower", ["reboot"], "lk.worksuite.power-force"),
            ("Journal", ["boot", 10], "lk.worksuite.diagnostics"),
            ("BootDetails", ["off"], "lk.worksuite.diagnostics"),
        ]
        for m, a, action in cases:
            _, h = self.call(m, list(a))
            self.assertEqual(h.asked, [action], m)
            self.assertEqual(len(h.runs), 1, m)
        self.assertEqual(set(bus.SIGNATURES), {m for m, _, _ in cases})

    def test_denied_and_dismissed_never_run_anything(self):
        with self.assertRaises(bus.NotAuthorized):
            self.call("Reinstall", [{"mode": "keep", "disk": "vda"}], h=(h := Harness(["no"])))
        self.assertEqual(h.runs, [])
        with self.assertRaises(bus.Cancelled):
            self.call("KioskExit", ["admin", ""], h=(h := Harness(["dismissed"])))
        self.assertEqual(h.runs, [])

    def test_invalid_arguments_never_reach_polkit(self):
        h = Harness()
        with self.assertRaises(bus.InvalidArgs):
            self.call("Reinstall", [{"mode": "keep", "disk": "vda", "source": "/x"}], h=h)
        self.assertEqual((h.asked, h.runs), ([], []))

    def test_caller_uid_from_the_bus_and_a_clean_environment(self):
        (code, out), h = self.call("KioskExit", ["pin", "482915"], uid=1234)
        argv, stdin, env = h.runs[0]
        self.assertEqual(env, {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "WORKSUITE_CALLER_UID": "1234"})
        self.assertEqual(stdin, b"482915\n")
        self.assertNotIn("482915", " ".join(argv))
        self.assertEqual((code, out), (0, ""), "kiosk exit output is not passed back")
        with self.assertRaises(bus.InvalidArgs):
            self.call("KioskExit", ["admin", ""], uid=0)

    def test_output_only_where_the_shell_shows_it(self):
        (code, out), _ = self.call("Journal", ["boot", 10], h=Harness(out="log line\n"))
        self.assertEqual((code, out), (0, "log line\n"))
        (code, out), _ = self.call("Reinstall", [{"mode": "keep", "disk": "vda"}], h=Harness(codes=[4]))
        self.assertEqual((code, out), (4, ""))
        (code, out), _ = self.call("Printers", [["remove", "P"]], h=Harness(codes=[1], err="lpadmin: Unknown destination\n"))
        self.assertEqual((code, out), (1, "lpadmin: Unknown destination\n"), "CUPS's reason for Settings › Printers")
        (code, out), _ = self.call("Printers", [["remove", "P"]])
        self.assertEqual((code, out), (0, ""))

    def test_missing_helper(self):
        (code, _), h = self.call("Reinstall", [{"mode": "keep", "disk": "vda"}], exists=lambda p: False)
        self.assertEqual((code, h.runs), (127, []))

    def test_force_power_asks_for_an_administrator_only_when_others_are_affected(self):
        (code, _), h = self.call("ForcePower", ["reboot"], h=Harness(codes=[0]))
        self.assertEqual((code, h.asked), (0, ["lk.worksuite.power-force"]))
        (code, _), h = self.call("ForcePower", ["reboot"], h=Harness(codes=[bus.NEEDS_ADMIN, 0]))
        self.assertEqual((code, h.asked), (0, ["lk.worksuite.power-force", "lk.worksuite.power-force-admin"]))
        self.assertNotIn("WORKSUITE_ADMIN_AUTHORIZED", h.runs[0][2])
        self.assertEqual(h.runs[1][2]["WORKSUITE_ADMIN_AUTHORIZED"], "1")
        with self.assertRaises(bus.Cancelled):
            self.call("ForcePower", ["reboot"], h=(h := Harness(["yes", "dismissed"], codes=[bus.NEEDS_ADMIN])))
        self.assertEqual(len(h.runs), 1)
        with self.assertRaises(bus.NotAuthorized):
            self.call("ForcePower", ["reboot"], h=Harness(["yes", "no"], codes=[bus.NEEDS_ADMIN]))

    def test_polkit_verdict(self):
        self.assertEqual(bus.verdict([True, False, {}]), "yes")
        self.assertEqual(bus.verdict([False, True, {}]), "no")
        self.assertEqual(bus.verdict([False, False, {"polkit.dismissed": "true"}]), "dismissed")

    # ---- packaging ----
    def test_interface_xml_lists_exactly_the_methods(self):
        for xml in (ROOT.joinpath("services/session/dbus/lk.worksuite.Admin1.xml").read_text(), bus.INTROSPECTION):
            ms = dict(re.findall(r'<method name="(\w+)">(.*?)</method>', xml))
            ms.pop("Introspect", None)
            self.assertEqual(sorted(ms), sorted(bus.SIGNATURES))
            for m, body in ms.items():
                self.assertEqual("".join(re.findall(r'type="([^"]+)" direction="in"', body)), bus.SIGNATURES[m], m)
        self.assertEqual(bus.introspect("/lk/worksuite"), '<node>\n  <node name="Admin1"/>\n</node>\n')

    def test_every_action_is_defined_and_the_apparmor_profile_runs_only_the_helpers(self):
        policies = "".join(p.read_text() for p in ROOT.joinpath("services").rglob("*.policy"))
        for a in ("lk.worksuite.kiosk.exit-pin", "lk.worksuite.kiosk.exit-admin", "lk.worksuite.recovery.reinstall",
                  "lk.worksuite.printers", "lk.worksuite.power-force", "lk.worksuite.power-force-admin", "lk.worksuite.diagnostics"):
            self.assertIn(f'<action id="{a}">', policies)
        reinstall = ROOT.joinpath("services/recovery-boot/polkit/lk.worksuite.recovery.policy").read_text()
        self.assertIn("<allow_active>auth_admin</allow_active>", reinstall)
        self.assertIn("<allow_any>no</allow_any>", reinstall)
        prof = ROOT.joinpath("security/apparmor/worksuite-admin-bus").read_text()
        execs = sorted(re.findall(r"^\s+(/\S+) (?:U|P|C)x,", prof, re.M))
        self.assertEqual(execs, sorted(bus.HELPERS))
        self.assertNotIn("pkexec", prof)


if __name__ == "__main__":
    unittest.main()
