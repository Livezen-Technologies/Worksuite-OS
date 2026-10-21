"""Workspaces on Labwc desktops (WSOS-DSK-003): tracker, key sender, rc.xml bindings and the D-Bus API."""
import asyncio
import os
import subprocess
import sys
import unittest
from pathlib import Path

from dbus_next import MessageType
from dbus_next.aio import MessageBus

from worksuite_bridge.access import AccessPolicy
from worksuite_bridge.model import ACTIVATED, NotFound, WindowRegistry
from worksuite_bridge.service import BRIDGE_IFACE, BRIDGE_PATH, EVENTS_IFACE, EVENTS_PATH, Bridge
from worksuite_bridge.workspace import LabwcKeys, WorkspaceTracker, parse_desktops, rc_bindings

from .busutil import PrivateBus
from .test_dbus import ME, FakeBackend, call

REPO = Path(__file__).resolve().parents[3]


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


class TrackerTest(unittest.TestCase):
    def setUp(self):
        self.reg = WindowRegistry()
        self.clock = Clock()
        self.ws = WorkspaceTracker(self.reg, count=4, wrap=True, clock=self.clock)
        self.changes = []
        self.ws.listeners.append(lambda: self.changes.append((self.ws.current, dict(self.ws.windows()))))

    def test_new_windows_open_on_the_current_workspace(self):
        a = self.reg.add("a", "foot", "A")
        self.ws.event("goto", 3)
        b = self.reg.add("b", "firefox", "B")
        self.assertEqual(self.ws.windows(), {a.handle: 1, b.handle: 3})
        self.assertEqual(self.ws.current, 3)

    def test_left_right_wrap_and_bad_input(self):
        self.ws.event("left")
        self.assertEqual(self.ws.current, 4)
        self.ws.event("right")
        self.assertEqual(self.ws.current, 1)
        for action, n in (("goto", 0), ("goto", 5), ("move", 9), ("explode", 1)):
            with self.assertRaises(NotFound):
                self.ws.event(action, n)
        ws = WorkspaceTracker(WindowRegistry(), count=4, wrap=False)
        ws.event("left")
        self.assertEqual(ws.current, 1)

    def test_keyboard_move_takes_the_window_that_had_focus(self):
        a = self.reg.add("a", "foot", "A", flags=ACTIVATED)
        b = self.reg.add("b", "gedit", "B")
        self.clock.t += 5
        # Super+Shift+2: Labwc sends A away and focuses B before the binding's event arrives.
        self.reg.update("a", flags=0)
        self.reg.update("b", flags=ACTIVATED)
        self.clock.t += 0.05
        self.ws.event("move", 2)
        self.assertEqual(self.ws.windows(), {a.handle: 2, b.handle: 1})
        self.assertEqual(self.ws.current, 1)
        # With no focus change (last window on the desktop), the focused window itself moves.
        self.clock.t += 5
        self.ws.event("move", 4)
        self.assertEqual(self.ws.windows()[b.handle], 4)

    def test_focus_on_another_workspace_follows_labwc(self):
        a = self.reg.add("a", "foot", "A")
        self.ws.moved(a.handle, 3)
        self.assertEqual(self.ws.current, 1)
        self.reg.update("a", flags=ACTIVATED)   # activated from the panel → Labwc goes to desktop 3
        self.assertEqual(self.ws.current, 3)
        self.reg.update("a", title="A2")          # still active: no change
        self.assertEqual(self.ws.current, 3)

    def test_panel_move_ignores_the_echo_of_its_binding(self):
        a = self.reg.add("a", "foot", "A", flags=ACTIVATED)
        b = self.reg.add("b", "foot", "B")
        self.ws.moved(a.handle, 2)
        self.reg.update("a", flags=0)
        self.reg.update("b", flags=ACTIVATED)
        self.ws.event("move", 2)               # the binding reports too
        self.assertEqual(self.ws.windows(), {a.handle: 2, b.handle: 1})

    def test_removed_windows_are_forgotten(self):
        a = self.reg.add("a", "foot", "A", flags=ACTIVATED)
        self.reg.remove("a")
        self.assertEqual(self.ws.windows(), {})
        self.assertNotIn(a.handle, self.ws.of)
        self.assertEqual(self.ws.focus_log, [])


class KeysTest(unittest.TestCase):
    def test_wtype_argv_holds_and_releases_the_modifiers(self):
        self.assertEqual(LabwcKeys.argv(2, False), ["wtype", "-M", "ctrl", "-M", "alt", "-M", "logo", "-k", "F2", "-m", "logo", "-m", "alt", "-m", "ctrl"])
        self.assertEqual(LabwcKeys.argv(3, True)[:9], ["wtype", "-M", "ctrl", "-M", "alt", "-M", "logo", "-M", "shift"])
        self.assertIn("F3", LabwcKeys.argv(3, True))
        ran = []
        k = LabwcKeys(run=lambda a: ran.append(a) or 0, which=lambda _n: "/usr/bin/wtype", settle_s=0)
        self.assertTrue(k.available())
        k.go(1)
        k.send_focused(4)
        self.assertEqual([r[r.index("-k") + 1] for r in ran], ["F1", "F4"])
        self.assertFalse(LabwcKeys(which=lambda _n: None).available())

    def test_rc_xml_has_the_generated_bindings(self):
        rc = (REPO / "services/session/labwc/rc.xml").read_text()
        for line in rc_bindings().splitlines():
            self.assertIn(line.strip(), rc)
        self.assertEqual(parse_desktops(rc), (1, ["Desktop 1"]))
        self.assertIn("ToggleTaskView", rc)
        self.assertIn('<windowSwitcher show="yes" preview="yes" outlines="yes" allWorkspaces="no">', rc)

    def test_event_helper_validates_and_never_blocks(self):
        helper = REPO / "services/session/bin/worksuite-workspace-event"
        env = {**os.environ, "PATH": "/nonexistent"}
        self.assertEqual(subprocess.run(["/bin/sh", str(helper), "goto", "x;reboot"], env=env, capture_output=True).returncode, 2)
        self.assertEqual(subprocess.run(["/bin/sh", str(helper), "bogus"], env=env, capture_output=True).returncode, 2)
        self.assertEqual(subprocess.run(["/bin/sh", str(helper), "goto", "17"], env=env, capture_output=True).returncode, 2)
        for args in (["goto", "16"], ["new"], ["close"]):
            self.assertEqual(subprocess.run(["/bin/sh", str(helper), *args], env=env, capture_output=True).returncode, 127)
        # busctl missing: fails quietly
        r = subprocess.run(["/bin/sh", str(helper), "goto", "2"], env=env, capture_output=True, text=True)
        self.assertEqual(r.stdout, "")


class WorkspaceDbusTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pb = PrivateBus().__enter__()
        self.registry = WindowRegistry()
        self.backend = FakeBackend()
        self.ran = []
        self.keys = LabwcKeys(run=lambda a: self.ran.append(a) or 0, which=lambda _n: "/usr/bin/wtype", settle_s=0)
        self.ws = WorkspaceTracker(self.registry, count=4)
        self.sbus = await MessageBus(bus_address=self.pb.address).connect()
        self.bridge = Bridge(self.sbus, self.backend, self.registry, AccessPolicy(allowed=(ME,)), workspaces=self.ws, keys=self.keys)
        await self.bridge.start()
        self.client = await MessageBus(bus_address=self.pb.address).connect()

    async def asyncTearDown(self):
        self.client.disconnect()
        self.sbus.disconnect()
        self.pb.__exit__(None, None, None)

    async def test_list_switch_move_and_signal(self):
        got = []
        self.client.add_message_handler(lambda m: got.append(list(m.body)) if m.message_type == MessageType.SIGNAL and m.member == "WorkspacesChanged" else None)
        await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "SubscribeWindowEvents")
        w = self.registry.add("n1", "foot", "T", flags=ACTIVATED)
        r = await call(self.client, BRIDGE_PATH, "org.freedesktop.DBus.Properties", "Get", "ss", [BRIDGE_IFACE, "SupportedOperations"])
        self.assertIn("workspaces", r.body[0].value)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ListWorkspaces")
        self.assertEqual(r.body, [1, 4, {w.handle: 1}])
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ActivateWorkspace", "u", [3])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        self.assertEqual(self.ran[-1][self.ran[-1].index("-k") + 1], "F3")
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "MoveWindowToWorkspace", "su", [w.handle, 2])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        self.assertEqual(self.backend.calls[-1], ("activate", "n1", ""))
        self.assertIn("shift", self.ran[-1])
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ListWorkspaces")
        self.assertEqual(r.body[2], {w.handle: 2})
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ActivateWorkspace", "u", [7])
        self.assertEqual(r.error_name, "lk.worksuite.WaylandBridge1.Error.NotFound")
        await asyncio.sleep(0.2)
        self.assertIn([3, 4], got)

    async def test_labwc_events_from_the_session_user(self):
        r = await call(self.client, EVENTS_PATH, EVENTS_IFACE, "Event", "su", ["goto", 4])
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN, r.body)
        self.assertEqual(self.ws.current, 4)
        self.bridge.policy = AccessPolicy(uid=os.getuid() + 1, allowed=(ME,))
        r = await call(self.client, EVENTS_PATH, EVENTS_IFACE, "Event", "su", ["goto", 1])
        self.assertEqual(r.error_name, "org.freedesktop.DBus.Error.AccessDenied")
        self.assertEqual(self.ws.current, 4)

    async def test_not_supported_without_wtype(self):
        self.keys.which = lambda _n: None
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ActivateWorkspace", "u", [2])
        self.assertEqual(r.error_name, "lk.worksuite.WaylandBridge1.Error.NotSupported")
        r = await call(self.client, BRIDGE_PATH, "org.freedesktop.DBus.Properties", "Get", "ss", [BRIDGE_IFACE, "SupportedOperations"])
        self.assertNotIn("workspaces", r.body[0].value)


if __name__ == "__main__":
    unittest.main()
