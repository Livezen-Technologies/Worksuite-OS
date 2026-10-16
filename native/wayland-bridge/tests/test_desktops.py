"""Dynamic desktops (WSOS-DSK-003): create, close (windows move left), reorder, rename, restore from the synced
preferences, windows on all desktops, Alt+Tab scope, rc.xml rewriting and output capture."""
import asyncio
import tempfile
import unittest
from pathlib import Path

from dbus_next import MessageType
from dbus_next.aio import MessageBus

from worksuite_bridge.access import AccessPolicy
from worksuite_bridge.capture import OutputCapture
from worksuite_bridge.model import ACTIVATED, MINIMIZED, NotFound, NotSupported, Output, WindowRegistry
from worksuite_bridge.service import BRIDGE_IFACE, BRIDGE_PATH, EVENTS_IFACE, EVENTS_PATH, Bridge
from worksuite_bridge.workspace import (MAX_WORKSPACES, Desktops, LabwcConfig, LabwcKeys, WorkspaceTracker, clean_name,
                                        desktops_element, parse_desktops, refresh_rc, rewrite_rc)

from .busutil import PrivateBus
from .test_dbus import ME, FakeBackend, call

RC = """<?xml version="1.0"?>
<labwc_config>
  <desktops number="2"/>
  <keyboard>
    <keybind key="A-Tab"><action name="NextWindow"/></keybind>
  </keyboard>
<!-- worksuite-touch:begin -->
  <touch deviceName="x" mapToOutput="HDMI-A-1" />
<!-- worksuite-touch:end -->
</labwc_config>
"""


class Rig:
    """A tracker with windows a, b, c on desktops 1, 2, 3 (of 4), and a Desktops controller on fakes."""

    def __init__(self, count=4, tmp=None):
        self.reg = WindowRegistry()
        self.ws = WorkspaceTracker(self.reg, count=count)
        self.keys_sent = []
        self.cmds = []
        self.keys = LabwcKeys(run=self._run, which=lambda _n: "/usr/bin/wtype", settle_s=0)
        self.rc = Path(tmp) / "rc.xml"
        self.rc.write_text(RC)
        self.config = LabwcConfig(user_rc=self.rc, system_rc=Path(tmp) / "missing.xml", run=self._run)
        self.activated = []

        async def direct(fn, *a):
            return fn(*a)
        self.d = Desktops(self.ws, self.keys, self.config, self._activate, blocking=direct, reload_settle_s=0)

    def _run(self, argv):
        if argv[0] == "wtype":
            self.keys_sent.append(argv[argv.index("-k") + 1] + ("+shift" if "shift" in argv else ""))
        else:
            self.cmds.append(argv)
        return 0

    def _activate(self, w):
        self.activated.append(w.handle)
        for x in self.reg.list():
            self.reg.update(x.native, flags=ACTIVATED if x is w else 0)

    def place(self, spec):
        """spec: {native: desktop}; returns {native: handle}."""
        out = {}
        for native, n in spec.items():
            w = self.reg.add(native, "app-" + native, native.upper())
            self.ws.moved(w.handle, n)
            out[native] = w.handle
        self.ws.expect.clear()
        return out

    def where(self, h):
        return {k: self.ws.windows()[v] for k, v in h.items()}


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.r = Rig(tmp=self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_close_moves_windows_left_and_shifts_later_desktops_down(self):
        h = self.r.place({"a": 1, "b": 2, "c": 3, "d": 4})
        self.r.ws.current = 2
        moves, current = self.r.ws.plan_remove(2)
        self.assertEqual(moves, {h["b"]: 1, h["c"]: 2, h["d"]: 3})
        self.assertEqual(current, 1)
        moves, current = self.r.ws.plan_remove(1)  # the first desktop: its windows go to the next one (now 1)
        self.assertEqual(moves, {h["b"]: 1, h["c"]: 2, h["d"]: 3})
        self.assertEqual(current, 1)
        self.assertEqual(self.r.ws.plan_remove(4), ({h["d"]: 3}, 2))

    def test_reorder_plan(self):
        h = self.r.place({"a": 1, "b": 2, "c": 3})
        self.r.ws.current = 1
        moves, current, order = self.r.ws.plan_reorder(1, 3)
        self.assertEqual(order, [2, 3, 1, 4])
        self.assertEqual(moves, {h["a"]: 3, h["b"]: 1, h["c"]: 2})
        self.assertEqual(current, 3)

    def test_sticky_and_shell_windows_never_move(self):
        h = self.r.place({"a": 2, "b": 2})
        shell = self.r.reg.add("shell", "worksuite-shell", "WorkSuite")
        self.r.ws.of[shell.handle] = 2
        self.r.ws.sticky.add(h["b"])
        moves, _ = self.r.ws.plan_remove(2)
        self.assertEqual(moves, {h["a"]: 1})

    def test_names_are_cleaned(self):
        self.assertEqual(clean_name("  Pro\x00jects\n "), "Projects")
        self.assertEqual(len(clean_name("x" * 100)), 40)


class ControllerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.r = Rig(tmp=self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    async def test_create_adds_a_desktop_rewrites_rc_and_switches(self):
        n = await self.r.d.create()
        self.assertEqual((n, self.r.ws.count, self.r.ws.current), (5, 5, 5))
        self.assertIn(["labwc", "--reconfigure"], self.r.cmds)
        self.assertEqual(self.r.keys_sent[-1], "F5")
        rc = self.r.rc.read_text()
        self.assertEqual(parse_desktops(rc), (5, ["Desktop 1", "Desktop 2", "Desktop 3", "Desktop 4", "Desktop 5"]))
        self.assertIn('mapToOutput="HDMI-A-1"', rc)   # the touch block stays

    async def test_count_limits(self):
        r = Rig(count=MAX_WORKSPACES, tmp=self.tmp.name)
        with self.assertRaises(NotSupported):
            await r.d.create()
        r1 = Rig(count=1, tmp=self.tmp.name)
        with self.assertRaises(NotSupported):
            await r1.d.remove(1)

    async def test_close_keeps_every_window_and_its_order(self):
        h = self.r.place({"a": 1, "b": 2, "c": 3, "d": 4})
        self.r.ws.names = ["", "Mail", "Code", ""]
        self.r._activate(self.r.reg.get(h["b"]))   # Labwc follows focus to desktop 2
        self.assertEqual(self.r.ws.current, 2)
        ids = list(self.r.ws.ids)
        await self.r.d.remove(2)
        self.assertEqual(self.r.ws.ids, [ids[0], ids[2], ids[3]])
        self.assertEqual(self.r.ws.count, 3)
        self.assertEqual(self.r.where(h), {"a": 1, "b": 1, "c": 2, "d": 3})
        self.assertEqual(self.r.ws.names, ["", "Code", ""])
        self.assertEqual(self.r.ws.current, 1)
        # Each moved window was focused and sent (F<n> with shift); focus went back to the window that had it.
        self.assertEqual([k for k in self.r.keys_sent if k.endswith("+shift")], ["F1+shift", "F2+shift", "F3+shift"])
        self.assertEqual(self.r.activated[-1], h["b"])
        self.assertEqual(parse_desktops(self.r.rc.read_text())[0], 3)
        # The bindings' own echoes ("move n") change nothing.
        for n in (1, 2, 3):
            self.r.ws.event("move", n)
        self.assertEqual(self.r.where(h), {"a": 1, "b": 1, "c": 2, "d": 3})

    async def test_reorder_moves_windows_and_names(self):
        h = self.r.place({"a": 1, "b": 2, "c": 3})
        self.r.ws.names = ["One", "Two", "Three", ""]
        ids = list(self.r.ws.ids)
        await self.r.d.reorder(3, 1)
        self.assertEqual(self.r.ws.names, ["Three", "One", "Two", ""])
        self.assertEqual(self.r.ws.ids, [ids[2], ids[0], ids[1], ids[3]])
        self.assertEqual(self.r.where(h), {"a": 2, "b": 3, "c": 1})
        self.assertEqual(self.r.ws.current, 2)  # desktop 1 (current) is now second
        self.assertEqual(parse_desktops(self.r.rc.read_text())[1][:3], ["Three", "One", "Two"])

    async def test_rename_and_restore(self):
        await self.r.d.rename(2, "  Research ")
        self.assertEqual(self.r.ws.names[1], "Research")
        self.assertIn("<name>Research</name>", self.r.rc.read_text())
        with self.assertRaises(NotFound):
            await self.r.d.rename(9, "x")
        h = self.r.place({"a": 1, "b": 3, "c": 4})
        self.r.ws.current = 4
        await self.r.d.restore(["Home", "Work"], "ඩෙස්ක්ටොප්")
        self.assertEqual((self.r.ws.count, self.r.ws.names, self.r.ws.current), (2, ["Home", "Work"], 2))
        self.assertEqual(self.r.where(h), {"a": 1, "b": 2, "c": 2})
        await self.r.d.restore(["", "", ""], "")
        self.assertEqual(parse_desktops(self.r.rc.read_text())[1], ["ඩෙස්ක්ටොප් 1", "ඩෙස්ක්ටොප් 2", "ඩෙස්ක්ටොප් 3"])

    async def test_on_all_desktops_and_switcher_scope(self):
        h = self.r.place({"a": 1, "b": 2})
        await self.r.d.set_window_sticky(h["a"], True)
        self.assertIn(h["a"], self.r.ws.sticky)
        self.assertEqual(self.r.keys_sent[-1], "F24")
        await self.r.d.set_window_sticky(h["a"], True)   # already: nothing sent
        self.assertEqual(self.r.keys_sent.count("F24"), 1)
        await self.r.d.set_app_sticky("app-b", True)
        self.assertIn(h["b"], self.r.ws.sticky)
        w = self.r.reg.add("b2", "app-b", "B2")         # a new window of that app follows
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertIn(w.handle, self.r.ws.sticky)
        await self.r.d.set_switcher_all(True)
        self.assertIn('allWorkspaces="yes"', self.r.rc.read_text())


    async def test_task_view_lifts_the_shell_and_puts_it_back(self):
        shell = self.r.reg.add("shell", "worksuite-shell", "WorkSuite")
        app = self.r.place({"a": 1})["a"]
        self.r.reg.update("a", flags=ACTIVATED)
        self.r.reg.update("a", flags=0)
        await self.r.d.set_shell_raised(shell.handle, True)
        self.assertEqual(self.r.keys_sent, ["F23"])             # the binding finds the shell itself (ForEach)
        self.assertEqual(self.r.activated[-1], shell.handle)    # then the shell gets the keyboard
        await self.r.d.set_shell_raised(shell.handle, True)     # again: raised again (an app may have gone over it)
        self.assertEqual(self.r.keys_sent, ["F23", "F21"])
        await self.r.d.set_shell_raised(shell.handle, False)
        self.assertEqual(self.r.keys_sent, ["F23", "F21", "F22"])
        self.assertEqual(self.r.activated[-1], app)              # the app used last gets the focus back
        await self.r.d.set_shell_raised(shell.handle, False)    # already below: nothing sent
        self.assertEqual(self.r.keys_sent, ["F23", "F21", "F22"])
        with self.assertRaises(NotFound):                       # only the shell's own windows
            await self.r.d.set_shell_raised(app, True)
        await self.r.d.set_shell_raised(shell.handle, True)
        self.r.reg.remove("shell")                              # a closed window forgets its state
        self.assertEqual(self.r.d.lifted, set())

    def test_top_app_is_the_one_used_last_on_that_desktop(self):
        h = self.r.place({"a": 1, "b": 1, "c": 2})
        self.r.reg.add("shell", "worksuite-shell", "WorkSuite")
        self.assertEqual(self.r.ws.top_app(1).handle, h["b"])   # none focused yet: the newest
        self.r.reg.update("a", flags=ACTIVATED)
        self.r.reg.update("a", flags=0)
        self.assertEqual(self.r.ws.top_app(1).handle, h["a"])
        self.assertEqual(self.r.ws.top_app(2).handle, h["c"])
        self.r.reg.update("a", flags=MINIMIZED)
        self.assertEqual(self.r.ws.top_app(1).handle, h["b"])
        self.assertIsNone(self.r.ws.top_app(3))

    def test_focusing_the_shell_does_not_change_the_desktop(self):
        shell = self.r.reg.add("shell", "worksuite-shell", "WorkSuite")   # added on desktop 1, always on bottom
        self.r.ws.event("goto", 3)
        self.r.reg.update("shell", flags=ACTIVATED)
        self.assertEqual(self.r.ws.current, 3)
        self.assertNotIn(shell.handle, self.r.ws._movable())


class RcTest(unittest.TestCase):
    def test_rewrite_keeps_everything_else(self):
        out = rewrite_rc(RC, ["A & B", "<x>"], True)
        self.assertEqual(parse_desktops(out), (2, ["A & B", "<x>"]))
        self.assertIn('<windowSwitcher allWorkspaces="yes"/>', out)
        self.assertIn('<keybind key="A-Tab">', out)
        again = rewrite_rc(out, ["One"], False)
        self.assertEqual(again.count("<desktops"), 1)
        self.assertEqual(again.count("<windowSwitcher"), 1)
        self.assertIn('allWorkspaces="no"', again)
        self.assertIn("<popupTime>0</popupTime>", desktops_element(["x"]))
        kept = rewrite_rc('<labwc_config><windowSwitcher show="yes" allWorkspaces="no"><fields/></windowSwitcher><keyboard/></labwc_config>', ["x"], True)
        self.assertIn('<windowSwitcher show="yes" allWorkspaces="yes"><fields/>', kept)

    def test_refresh_takes_rules_from_the_system_file_and_keeps_the_users_parts(self):
        system = (Path(__file__).resolve().parents[3] / "services/session/labwc/rc.xml").read_text()
        stale = system.replace('<action name="ToggleAlwaysOnBottom"/>\n    </windowRule>', '<action name="ToggleOmnipresent"/>\n    </windowRule>')
        stale = rewrite_rc(stale, ["Mail", "Code", "Play"], True)
        stale = stale.replace("</labwc_config>", "<!-- worksuite-touch:begin (x) -->\n  <touch deviceName=\"t\" mapToOutput=\"HDMI-A-1\" />\n<!-- worksuite-touch:end -->\n</labwc_config>")
        out = refresh_rc(stale, system)
        rule = out[out.index('<windowRule identifier="worksuite-shell"'):]
        rule = rule[:rule.index("</windowRule>")]
        self.assertIn("ToggleAlwaysOnBottom", rule)
        self.assertNotIn("ToggleOmnipresent", rule)
        self.assertEqual(parse_desktops(out), (3, ["Mail", "Code", "Play"]))
        self.assertIn('<windowSwitcher allWorkspaces="yes"/>', out)
        self.assertEqual(out.count("worksuite-touch:begin"), 1)
        self.assertLess(out.index('<touch deviceName="t"'), out.index("</labwc_config>"))
        self.assertEqual(refresh_rc(out, system), out)          # stable
        self.assertEqual(refresh_rc("", system), system)
        self.assertEqual(refresh_rc(stale, ""), stale)

    def test_write_rebuilds_a_stale_copy_from_the_system_file(self):
        with tempfile.TemporaryDirectory() as d:
            sysrc, user = Path(d) / "sys.xml", Path(d) / "rc.xml"
            sysrc.write_text(RC.replace("<keyboard>", '<windowRules><windowRule identifier="worksuite-shell"><action name="ToggleAlwaysOnBottom"/></windowRule></windowRules>\n  <keyboard>'))
            user.write_text(RC.replace("<keyboard>", '<windowRules><windowRule identifier="worksuite-shell"><action name="ToggleOmnipresent"/></windowRule></windowRules>\n  <keyboard>'))
            LabwcConfig(user_rc=user, system_rc=sysrc, run=lambda _a: 0).write(["a", "b"], False)
            text = user.read_text()
            self.assertIn("ToggleAlwaysOnBottom", text)
            self.assertNotIn("ToggleOmnipresent", text)
            self.assertIn('<touch deviceName="x"', text)
            self.assertEqual(parse_desktops(text), (2, ["a", "b"]))

    def test_symlinked_user_rc_becomes_a_file(self):
        with tempfile.TemporaryDirectory() as d:
            sysrc = Path(d) / "sys.xml"
            sysrc.write_text(RC)
            user = Path(d) / "labwc" / "rc.xml"
            user.parent.mkdir()
            user.symlink_to(sysrc)
            LabwcConfig(user_rc=user, system_rc=sysrc, run=lambda _a: 0).write(["x", "y", "z"], False)
            self.assertFalse(user.is_symlink())
            self.assertEqual(sysrc.read_text(), RC)
            self.assertEqual(parse_desktops(user.read_text())[0], 3)

    def test_reconfigure_falls_back_to_sighup(self):
        ran = []
        cfg = LabwcConfig(user_rc=Path("/nonexistent/rc.xml"), run=lambda a: ran.append(a) or (1 if a[0] == "labwc" else 0))
        import os
        os.environ["LABWC_PID"] = "1234"
        try:
            cfg.reconfigure()
        finally:
            del os.environ["LABWC_PID"]
        self.assertEqual(ran[-1], ["kill", "-HUP", "1234"])
        with self.assertRaises(NotSupported):
            LabwcConfig(user_rc=Path("/nonexistent/rc.xml"), run=lambda a: 1).reconfigure()


class CaptureTest(unittest.TestCase):
    def test_grim_argv_is_small_and_to_stdout(self):
        argv = OutputCapture.argv(Output("HDMI-A-1", width=1920), 320)
        self.assertEqual(argv[:3], ["grim", "-o", "HDMI-A-1"])
        self.assertEqual(argv[argv.index("-s") + 1], "0.167")
        self.assertEqual(argv[-1], "-")   # standard output: never a file
        seen = []
        c = OutputCapture(capture=lambda a: seen.append(a) or b"\xff\xd8jpeg", which=lambda _n: "/usr/bin/grim")
        self.assertEqual(c.grab([Output("eDP-1", width=1280)], "", 9999), b"\xff\xd8jpeg")
        self.assertEqual(seen[0][seen[0].index("-s") + 1], "0.500")   # capped at 640 px
        with self.assertRaises(NotFound):
            c.grab([Output("eDP-1")], "HDMI-A-9", 300)
        with self.assertRaises(NotFound):
            c.grab([Output("bad;name")], "bad;name", 300)
        with self.assertRaises(NotSupported):
            OutputCapture(which=lambda _n: None).grab([Output("eDP-1")], "", 300)


class DesktopsDbusTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pb = PrivateBus().__enter__()
        self.registry = WindowRegistry()
        self.backend = FakeBackend()
        self.ran = []
        run = lambda a: self.ran.append(a) or 0  # noqa: E731
        self.keys = LabwcKeys(run=run, which=lambda _n: "/usr/bin/wtype", settle_s=0)
        rc = Path(self.tmp.name) / "rc.xml"
        rc.write_text(RC)
        self.ws = WorkspaceTracker(self.registry, count=2)
        self.sbus = await MessageBus(bus_address=self.pb.address).connect()
        self.bridge = Bridge(self.sbus, self.backend, self.registry, AccessPolicy(allowed=(ME,)), workspaces=self.ws, keys=self.keys,
                             config=LabwcConfig(user_rc=rc, run=run),
                             capture=OutputCapture(capture=lambda _a: b"JPEG", which=lambda _n: "/usr/bin/grim"))
        self.bridge.desktops.reload_settle_s = 0
        await self.bridge.start()
        self.client = await MessageBus(bus_address=self.pb.address).connect()

    async def asyncTearDown(self):
        self.client.disconnect()
        self.sbus.disconnect()
        self.pb.__exit__(None, None, None)
        self.tmp.cleanup()

    async def test_desktops_over_dbus(self):
        r = await call(self.client, BRIDGE_PATH, "org.freedesktop.DBus.Properties", "Get", "ss", [BRIDGE_IFACE, "SupportedOperations"])
        self.assertTrue({"workspaces", "dynamic-workspaces", "capture-output"} <= set(r.body[0].value))
        w = self.registry.add("n1", "foot", "T", flags=ACTIVATED)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "CreateWorkspace")
        self.assertEqual(r.body, [3], r.body)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "RenameWorkspace", "us", [3, "Research"])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "MoveWorkspace", "uu", [3, 1])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "SetWindowOnAllWorkspaces", "sb", [w.handle, True])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "WorkspaceDetails")
        self.assertEqual(r.body[:6], [1, ["Research", "", ""], {w.handle: 2}, [w.handle], [], False])
        self.assertEqual(r.body[6], self.ws.ids)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "RemoveWorkspace", "u", [1])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "RestoreWorkspaces", "ass", [["A", "B", "C"], "Desktop"])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        self.assertEqual(self.ws.count, 3)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "CaptureOutput", "su", ["", 320])
        self.assertEqual(r.body, [b"JPEG", "image/jpeg"])
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "RemoveWorkspace", "u", [9])
        self.assertEqual(r.error_name, "lk.worksuite.WaylandBridge1.Error.NotFound")
        shell = self.registry.add("sh", "worksuite-shell", "WorkSuite")
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "SetShellRaised", "sb", [shell.handle, True])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        self.assertEqual(self.bridge.desktops.lifted, {shell.handle})
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "SetShellRaised", "sb", [shell.handle, False])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        self.assertEqual(self.bridge.desktops.lifted, set())
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "SetShellRaised", "sb", [w.handle, True])
        self.assertEqual(r.error_name, "lk.worksuite.WaylandBridge1.Error.NotFound")

    async def test_keyboard_new_and_close(self):
        r = await call(self.client, EVENTS_PATH, EVENTS_IFACE, "Event", "su", ["new", 0])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        for _ in range(50):
            if self.ws.count == 3:
                break
            await asyncio.sleep(0.02)
        self.assertEqual((self.ws.count, self.ws.current), (3, 3))
        await call(self.client, EVENTS_PATH, EVENTS_IFACE, "Event", "su", ["close", 0])
        for _ in range(50):
            if self.ws.count == 2:
                break
            await asyncio.sleep(0.02)
        self.assertEqual((self.ws.count, self.ws.current), (2, 2))


if __name__ == "__main__":
    unittest.main()
