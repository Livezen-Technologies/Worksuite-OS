"""D-Bus contract tests against a private bus with a fake compositor backend."""
import asyncio
import os
import sys
import unittest

from dbus_next import Message, MessageType, PropertyAccess
from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, dbus_property, method

from worksuite_bridge.access import AccessPolicy
from worksuite_bridge.model import ACTIVATED, Backend, Output, WindowRegistry
from worksuite_bridge.service import BRIDGE_IFACE, BRIDGE_PATH, BUS_NAME, TRAY_IFACE, TRAY_PATH, WATCHER_IFACE, WATCHER_NAME, WATCHER_PATH, Bridge

from .busutil import PrivateBus

ME = os.path.realpath(sys.executable)


class FakeBackend(Backend):
    def __init__(self, ops=("activate", "close", "minimize")):
        self.ops = list(ops)
        self.calls = []

    def supported_operations(self):
        return self.ops

    def outputs(self):
        return [Output("HDMI-A-1", "Dell", 0, 0, 1920, 1080, 1.5)]

    def activate(self, native, token):
        self.calls.append(("activate", native, token))

    def close(self, native):
        self.calls.append(("close", native))

    def set_minimized(self, native, state):
        self.calls.append(("minimize", native, state))


class Item(ServiceInterface):
    def __init__(self):
        super().__init__("org.kde.StatusNotifierItem")
        self.activated = []

    @dbus_property(access=PropertyAccess.READ)
    def Id(self) -> "s":
        return "nm-applet"

    @dbus_property(access=PropertyAccess.READ)
    def Title(self) -> "s":
        return "Network"

    @dbus_property(access=PropertyAccess.READ)
    def IconName(self) -> "s":
        return "network-wireless"

    @dbus_property(access=PropertyAccess.READ)
    def Status(self) -> "s":
        return "Active"

    @method()
    def Activate(self, x: "i", y: "i"):
        self.activated.append((x, y))


async def call(bus, path, iface, member, sig="", body=None, dest=BUS_NAME):
    return await bus.call(Message(destination=dest, path=path, interface=iface, member=member, signature=sig, body=body or []))


class BridgeDbusTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pb = PrivateBus().__enter__()
        self.registry = WindowRegistry()
        self.backend = FakeBackend()
        self.sbus = await MessageBus(bus_address=self.pb.address).connect()
        self.bridge = Bridge(self.sbus, self.backend, self.registry, AccessPolicy(allowed=(ME,)))
        await self.bridge.start()
        self.client = await MessageBus(bus_address=self.pb.address).connect()

    async def asyncTearDown(self):
        self.client.disconnect()
        self.sbus.disconnect()
        self.pb.__exit__(None, None, None)

    async def test_list_activate_close_minimize(self):
        w = self.registry.add("native-1", "foot", "Terminal", "HDMI-A-1", ACTIVATED)
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ListWindows")
        self.assertEqual(r.body[0], [[w.handle, "foot", "Terminal", "HDMI-A-1", ACTIVATED]])
        await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ActivateWindow", "ss", [w.handle, "tok"])
        await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "SetMinimized", "sb", [w.handle, True])
        await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "CloseWindow", "s", [w.handle])
        self.assertEqual(self.backend.calls, [("activate", "native-1", "tok"), ("minimize", "native-1", True), ("close", "native-1")])
        o = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ListOutputs")
        self.assertEqual(o.body[0], [["HDMI-A-1", "Dell", 0, 0, 1920, 1080, 1.5]])

    async def test_stale_handle_is_not_found(self):
        w = self.registry.add("n", "foot", "t")
        self.registry.remove("n")
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "CloseWindow", "s", [w.handle])
        self.assertEqual(r.error_name, "lk.worksuite.WaylandBridge1.Error.NotFound")
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ActivateWindow", "ss", ["garbage", ""])
        self.assertEqual(r.error_name, "lk.worksuite.WaylandBridge1.Error.NotFound")
        # still alive
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ListWindows")
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN)

    async def test_not_supported_and_property(self):
        self.backend.ops = ["close"]
        w = self.registry.add("n", "foot", "t")
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ActivateWindow", "ss", [w.handle, ""])
        self.assertEqual(r.error_name, "lk.worksuite.WaylandBridge1.Error.NotSupported")
        r = await call(self.client, BRIDGE_PATH, "org.freedesktop.DBus.Properties", "Get", "ss", [BRIDGE_IFACE, "SupportedOperations"])
        self.assertEqual(r.body[0].value, ["close"])

    async def test_other_programs_are_denied(self):
        self.bridge.policy = AccessPolicy(allowed=("/usr/lib/worksuite/shell/electron/electron",))
        r = await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "ListWindows")
        self.assertEqual(r.error_name, "org.freedesktop.DBus.Error.AccessDenied")
        r = await call(self.client, TRAY_PATH, TRAY_IFACE, "ListItems")
        self.assertEqual(r.error_name, "org.freedesktop.DBus.Error.AccessDenied")
        # Introspection stays open.
        r = await call(self.client, BRIDGE_PATH, "org.freedesktop.DBus.Introspectable", "Introspect")
        self.assertIn("ListWindows", r.body[0])

    async def test_signals_only_to_subscribers(self):
        got, other = [], []
        self.client.add_message_handler(lambda m: got.append(m.member) if m.message_type == MessageType.SIGNAL and m.interface == BRIDGE_IFACE else None)
        bystander = await MessageBus(bus_address=self.pb.address).connect()
        await call(bystander, "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", "s", [f"interface='{BRIDGE_IFACE}'"], "org.freedesktop.DBus")
        bystander.add_message_handler(lambda m: other.append(m.member) if m.message_type == MessageType.SIGNAL and m.interface == BRIDGE_IFACE else None)
        await call(self.client, BRIDGE_PATH, BRIDGE_IFACE, "SubscribeWindowEvents")
        self.registry.add("n", "foot", "t")
        self.registry.update("n", title="u")
        self.registry.remove("n")
        await asyncio.sleep(0.2)
        self.assertEqual(got, ["WindowAdded", "WindowChanged", "WindowRemoved"])
        self.assertEqual(other, [])
        bystander.disconnect()

    async def test_tray_watcher(self):
        app = await MessageBus(bus_address=self.pb.address).connect()
        item = Item()
        app.export("/StatusNotifierItem", item)
        r = await call(app, WATCHER_PATH, WATCHER_IFACE, "RegisterStatusNotifierItem", "s", ["/StatusNotifierItem"], WATCHER_NAME)
        self.assertEqual(r.message_type, MessageType.METHOD_RETURN)
        r = await call(self.client, TRAY_PATH, TRAY_IFACE, "ListItems")
        key = f"{app.unique_name}/StatusNotifierItem"
        self.assertEqual(r.body[0], [[key, "nm-applet", "Network", "network-wireless", "Active"]])
        await call(self.client, TRAY_PATH, TRAY_IFACE, "Activate", "sii", [key, 10, 20])
        await asyncio.sleep(0.1)
        self.assertEqual(item.activated, [(10, 20)])
        r = await call(self.client, WATCHER_PATH, "org.freedesktop.DBus.Properties", "Get", "ss", [WATCHER_IFACE, "RegisteredStatusNotifierItems"], WATCHER_NAME)
        self.assertEqual(r.body[0].value, [key])
        app.disconnect()  # item leaves the bus → unregistered
        for _ in range(20):
            await asyncio.sleep(0.05)
            if not self.bridge.items:
                break
        self.assertEqual(self.bridge.items, {})
        r = await call(self.client, TRAY_PATH, TRAY_IFACE, "Activate", "sii", [key, 0, 0])
        self.assertEqual(r.error_name, "lk.worksuite.WaylandBridge1.Error.NotFound")


if __name__ == "__main__":
    unittest.main()
