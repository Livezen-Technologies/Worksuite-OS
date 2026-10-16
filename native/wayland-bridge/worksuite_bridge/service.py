"""D-Bus side of the bridge: lk.worksuite.WaylandBridge1, lk.worksuite.Tray1 and org.kde.StatusNotifierWatcher.

Method calls are dispatched by hand (not dbus-next ServiceInterface) because every call needs the sender's
credentials before it runs (WSOS-SHL-004). Window signals go only to subscribed, verified callers.
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Awaitable, Callable

from dbus_next import Message, MessageType, Variant
from dbus_next.aio import MessageBus
from dbus_next.errors import DBusError

from .access import AccessPolicy
from .model import OPERATIONS, AccessDenied, Backend, BridgeError, NotFound, NotSupported, Window, WindowRegistry
from .workspace import LabwcKeys, WorkspaceTracker

log = logging.getLogger("worksuite-bridge")

BUS_NAME = "lk.worksuite.WaylandBridge1"
BRIDGE_PATH = "/lk/worksuite/WaylandBridge1"
BRIDGE_IFACE = "lk.worksuite.WaylandBridge1"
TRAY_PATH = "/lk/worksuite/Tray1"
TRAY_IFACE = "lk.worksuite.Tray1"
WATCHER_NAME = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"
WATCHER_IFACE = "org.kde.StatusNotifierWatcher"
ITEM_IFACE = "org.kde.StatusNotifierItem"
PROPS = "org.freedesktop.DBus.Properties"
INTROSPECTABLE = "org.freedesktop.DBus.Introspectable"
# Labwc's desktop bindings report here (worksuite-workspace-event); open to processes of the session's user.
EVENTS_PATH = "/lk/worksuite/WaylandBridge1/Workspaces"
EVENTS_IFACE = "lk.worksuite.WorkspaceEvents1"
EVENTS_XML = """<node>
  <interface name="lk.worksuite.WorkspaceEvents1">
    <!-- action: goto | left | right | move; index 1-based (0 for left/right) -->
    <method name="Event"><arg name="action" type="s" direction="in"/><arg name="index" type="u" direction="in"/></method>
  </interface>
</node>"""

WATCHER_XML = """<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem"><arg name="service" type="s" direction="in"/></method>
    <method name="RegisterStatusNotifierHost"><arg name="service" type="s" direction="in"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
  </interface>
</node>"""


def _interface_xml(name: str) -> str:
    """Introspection data from the installed interface file, or the source tree when running from git."""
    for d in (os.environ.get("WORKSUITE_BRIDGE_XML_DIR"), "/usr/share/dbus-1/interfaces", str(Path(__file__).resolve().parent.parent)):
        if d and (Path(d) / f"{name}.xml").is_file():
            return (Path(d) / f"{name}.xml").read_text()
    return f'<node><interface name="{name}"/></node>'


Handler = Callable[[Message], Awaitable[tuple[str, list[Any]]]]


class Bridge:
    def __init__(self, bus: MessageBus, backend: Backend, registry: WindowRegistry, policy: AccessPolicy,
                 workspaces: WorkspaceTracker | None = None, keys: LabwcKeys | None = None):
        self.bus, self.backend, self.registry, self.policy = bus, backend, registry, policy
        self.workspaces, self.keys = workspaces, keys
        if workspaces is not None:
            workspaces.listeners.append(self._workspaces_changed)
        self.subscribers: set[str] = set()
        self._creds: dict[str, bool] = {}
        self.items: dict[str, tuple[str, str]] = {}  # key → (owner unique name, object path)
        self.routes: dict[tuple[str, str, str], Handler] = {
            (BRIDGE_PATH, BRIDGE_IFACE, "ListWindows"): self._list_windows,
            (BRIDGE_PATH, BRIDGE_IFACE, "ActivateWindow"): self._activate,
            (BRIDGE_PATH, BRIDGE_IFACE, "CloseWindow"): self._close,
            (BRIDGE_PATH, BRIDGE_IFACE, "SetMinimized"): self._set_minimized,
            (BRIDGE_PATH, BRIDGE_IFACE, "SubscribeWindowEvents"): self._subscribe,
            (BRIDGE_PATH, BRIDGE_IFACE, "ListOutputs"): self._list_outputs,
            (BRIDGE_PATH, BRIDGE_IFACE, "ListWorkspaces"): self._list_workspaces,
            (BRIDGE_PATH, BRIDGE_IFACE, "ActivateWorkspace"): self._activate_workspace,
            (BRIDGE_PATH, BRIDGE_IFACE, "MoveWindowToWorkspace"): self._move_to_workspace,
            (EVENTS_PATH, EVENTS_IFACE, "Event"): self._workspace_event,
            (EVENTS_PATH, INTROSPECTABLE, "Introspect"): self._xml(EVENTS_XML),
            (BRIDGE_PATH, PROPS, "Get"): self._bridge_prop_get,
            (BRIDGE_PATH, PROPS, "GetAll"): self._bridge_prop_get_all,
            (BRIDGE_PATH, INTROSPECTABLE, "Introspect"): self._xml(_interface_xml(BRIDGE_IFACE)),
            (TRAY_PATH, TRAY_IFACE, "ListItems"): self._tray_list,
            (TRAY_PATH, TRAY_IFACE, "Activate"): self._tray_activate,
            (TRAY_PATH, INTROSPECTABLE, "Introspect"): self._xml(_interface_xml(TRAY_IFACE)),
            (WATCHER_PATH, WATCHER_IFACE, "RegisterStatusNotifierItem"): self._sni_register_item,
            (WATCHER_PATH, WATCHER_IFACE, "RegisterStatusNotifierHost"): self._sni_register_host,
            (WATCHER_PATH, PROPS, "Get"): self._watcher_prop_get,
            (WATCHER_PATH, PROPS, "GetAll"): self._watcher_prop_get_all,
            (WATCHER_PATH, INTROSPECTABLE, "Introspect"): self._xml(WATCHER_XML),
        }
        # Window calls must come from the shell/panel; the watcher is open to every tray app.
        self.protected = {BRIDGE_PATH, TRAY_PATH}
        registry.listeners.append(self._window_event)
        bus.add_message_handler(self._on_message)

    async def start(self, own_names: bool = True) -> None:
        await self.bus.call(Message(destination="org.freedesktop.DBus", path="/org/freedesktop/DBus", interface="org.freedesktop.DBus",
                                    member="AddMatch", signature="s",
                                    body=["type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'"]))
        if own_names:
            for name in (BUS_NAME, WATCHER_NAME):
                await self.bus.request_name(name)
            self._signal(WATCHER_PATH, WATCHER_IFACE, "StatusNotifierHostRegistered", "", [])

    # ---- dispatch -------------------------------------------------------------------------------------
    def _on_message(self, msg: Message) -> bool:
        if msg.message_type == MessageType.SIGNAL:
            if msg.member == "NameOwnerChanged" and msg.sender == "org.freedesktop.DBus":
                name, _old, new = msg.body
                if not new:
                    self._name_gone(name)
            return False
        if msg.message_type != MessageType.METHOD_CALL:
            return False
        fn = self.routes.get((msg.path, msg.interface or "", msg.member))
        if fn is None:
            if msg.path in (BRIDGE_PATH, TRAY_PATH, WATCHER_PATH, EVENTS_PATH):
                self.bus.send(Message.new_error(msg, "org.freedesktop.DBus.Error.UnknownMethod", f"{msg.interface}.{msg.member}"))
                return True
            return False
        asyncio.get_running_loop().create_task(self._run(fn, msg))
        return True

    async def _run(self, fn: Handler, msg: Message) -> None:
        try:
            if msg.path in self.protected and msg.interface != INTROSPECTABLE and not await self._permitted(msg.sender):
                raise AccessDenied("only the WorkSuite shell or panel may use this interface")
            if msg.path == EVENTS_PATH and msg.interface != INTROSPECTABLE and await self._uid(msg.sender) != self.policy.uid:
                raise AccessDenied("only the session's own processes may report workspace changes")
            sig, body = await fn(msg)
            self.bus.send(Message.new_method_return(msg, sig, body))
        except BridgeError as e:
            self.bus.send(Message.new_error(msg, e.name, str(e)))
        except DBusError as e:
            self.bus.send(Message.new_error(msg, e.type, e.text))
        except Exception as e:  # never crash on a bad call (WSOS-SHL-003)
            log.exception("call failed")
            self.bus.send(Message.new_error(msg, "lk.worksuite.WaylandBridge1.Error.Failed", str(e)))

    async def _permitted(self, sender: str) -> bool:
        if sender not in self._creds:
            reply = await self.bus.call(Message(destination="org.freedesktop.DBus", path="/org/freedesktop/DBus", interface="org.freedesktop.DBus",
                                                member="GetConnectionCredentials", signature="s", body=[sender]))
            c = reply.body[0] if reply.message_type == MessageType.METHOD_RETURN else {}
            uid = c["UnixUserID"].value if "UnixUserID" in c else None
            pid = c["ProcessID"].value if "ProcessID" in c else None
            self._creds[sender] = self.policy.permits(uid, pid)  # unique names are never reused
        return self._creds[sender]

    async def _uid(self, sender: str):
        reply = await self.bus.call(Message(destination="org.freedesktop.DBus", path="/org/freedesktop/DBus", interface="org.freedesktop.DBus",
                                            member="GetConnectionUnixUser", signature="s", body=[sender]))
        return reply.body[0] if reply.message_type == MessageType.METHOD_RETURN else None

    def _signal(self, path: str, iface: str, member: str, sig: str, body: list[Any], destination: str | None = None) -> None:
        self.bus.send(Message.new_signal(path, iface, member, sig, body) if destination is None else
                      Message(message_type=MessageType.SIGNAL, path=path, interface=iface, member=member, signature=sig, body=body, destination=destination))

    @staticmethod
    def _xml(xml: str) -> Handler:
        async def fn(_msg: Message) -> tuple[str, list[Any]]:
            return "s", [xml]
        return fn

    def _name_gone(self, name: str) -> None:
        self.subscribers.discard(name)
        self._creds.pop(name, None)
        for key, (owner, _p) in list(self.items.items()):
            if owner == name or key.split("/", 1)[0] == name:
                self._drop_item(key)

    # ---- windows ---------------------------------------------------------------------------------------
    def _need(self, op: str) -> None:
        if op not in self.backend.supported_operations():
            raise NotSupported(f"{op} is not supported by the running compositor")

    async def _list_windows(self, _m: Message) -> tuple[str, list[Any]]:
        return "a(ssssu)", [[[w.handle, w.app_id, w.title, w.output, w.flags] for w in self.registry.list()]]

    async def _activate(self, m: Message) -> tuple[str, list[Any]]:
        handle, token = m.body
        self._need("activate")
        self.backend.activate(self.registry.get(handle).native, token)
        return "", []

    async def _close(self, m: Message) -> tuple[str, list[Any]]:
        self._need("close")
        self.backend.close(self.registry.get(m.body[0]).native)
        return "", []

    async def _set_minimized(self, m: Message) -> tuple[str, list[Any]]:
        handle, state = m.body
        self._need("minimize")
        self.backend.set_minimized(self.registry.get(handle).native, bool(state))
        return "", []

    async def _subscribe(self, m: Message) -> tuple[str, list[Any]]:
        self.subscribers.add(m.sender)
        return "", []

    async def _list_outputs(self, _m: Message) -> tuple[str, list[Any]]:
        return "a(ssiiiid)", [[list(o.row()) for o in self.backend.outputs()]]

    def _bridge_props(self) -> dict[str, Variant]:
        ops = [o for o in OPERATIONS if o in self.backend.supported_operations()]
        if self._workspaces_ok():
            ops.append("workspaces")
        return {"SupportedOperations": Variant("as", ops)}

    # ---- workspaces (Labwc desktops, see workspace.py) -------------------------------------------------------
    def _workspaces_ok(self) -> bool:
        return self.workspaces is not None and self.keys is not None and self.workspaces.count > 1 and self.keys.available()

    def _need_workspaces(self) -> WorkspaceTracker:
        if not self._workspaces_ok():
            raise NotSupported("workspaces are not available (one desktop, or no virtual keyboard tool)")
        return self.workspaces  # type: ignore[return-value]

    async def _list_workspaces(self, _m: Message) -> tuple[str, list[Any]]:
        ws = self.workspaces
        if ws is None:
            return "uua{su}", [1, 1, {}]
        return "uua{su}", [ws.current, ws.count, ws.windows()]

    async def _activate_workspace(self, m: Message) -> tuple[str, list[Any]]:
        ws = self._need_workspaces()
        n = ws.check(int(m.body[0]))
        await asyncio.get_running_loop().run_in_executor(None, self.keys.go, n)  # type: ignore[union-attr]
        ws.event("goto", n)
        return "", []

    async def _move_to_workspace(self, m: Message) -> tuple[str, list[Any]]:
        ws = self._need_workspaces()
        handle, n = m.body[0], ws.check(int(m.body[1]))
        w = self.registry.get(handle)
        self._need("activate")
        # SendToDesktop acts on the focused window: focus it first, then send the bridge-only binding.
        self.backend.activate(w.native, "")
        ws.moved(handle, n)
        await asyncio.get_running_loop().run_in_executor(None, self.keys.send_focused, n)  # type: ignore[union-attr]
        return "", []

    async def _workspace_event(self, m: Message) -> tuple[str, list[Any]]:
        if self.workspaces is not None:
            self.workspaces.event(str(m.body[0]), int(m.body[1]))
        return "", []

    def _workspaces_changed(self) -> None:
        ws = self.workspaces
        for dest in list(self.subscribers):
            self._signal(BRIDGE_PATH, BRIDGE_IFACE, "WorkspacesChanged", "uu", [ws.current, ws.count], dest)  # type: ignore[union-attr]

    async def _bridge_prop_get(self, m: Message) -> tuple[str, list[Any]]:
        props = self._bridge_props()
        if m.body[0] != BRIDGE_IFACE or m.body[1] not in props:
            raise DBusError("org.freedesktop.DBus.Error.UnknownProperty", m.body[1])
        return "v", [props[m.body[1]]]

    async def _bridge_prop_get_all(self, m: Message) -> tuple[str, list[Any]]:
        return "a{sv}", [self._bridge_props() if m.body[0] in (BRIDGE_IFACE, "") else {}]

    def _window_event(self, kind: str, w: Window) -> None:
        for dest in list(self.subscribers):
            if kind == "added":
                self._signal(BRIDGE_PATH, BRIDGE_IFACE, "WindowAdded", "sss", [w.handle, w.app_id, w.title], dest)
            elif kind == "changed":
                self._signal(BRIDGE_PATH, BRIDGE_IFACE, "WindowChanged", "sssu", [w.handle, w.title, w.output, w.flags], dest)
            else:
                self._signal(BRIDGE_PATH, BRIDGE_IFACE, "WindowRemoved", "s", [w.handle], dest)

    def outputs_changed(self) -> None:
        for dest in list(self.subscribers):
            self._signal(BRIDGE_PATH, BRIDGE_IFACE, "OutputsChanged", "", [], dest)

    # ---- tray (StatusNotifierWatcher + lk.worksuite.Tray1) -------------------------------------------------
    async def _sni_register_item(self, m: Message) -> tuple[str, list[Any]]:
        arg = m.body[0]
        # Apps pass either an object path (Ayatana/libappindicator) or a bus name (KDE/Qt).
        if arg.startswith("/"):
            owner, path = m.sender, arg
            name = m.sender
        else:
            owner, path, name = m.sender, "/StatusNotifierItem", arg
        key = f"{name}{path}"
        if key not in self.items:
            self.items[key] = (owner, path)
            self._signal(WATCHER_PATH, WATCHER_IFACE, "StatusNotifierItemRegistered", "s", [key])
            self._signal(TRAY_PATH, TRAY_IFACE, "ItemsChanged", "", [])
        return "", []

    async def _sni_register_host(self, _m: Message) -> tuple[str, list[Any]]:
        return "", []

    def _drop_item(self, key: str) -> None:
        if self.items.pop(key, None) is not None:
            self._signal(WATCHER_PATH, WATCHER_IFACE, "StatusNotifierItemUnregistered", "s", [key])
            self._signal(TRAY_PATH, TRAY_IFACE, "ItemsChanged", "", [])

    def _watcher_props(self) -> dict[str, Variant]:
        return {"RegisteredStatusNotifierItems": Variant("as", list(self.items)),
                "IsStatusNotifierHostRegistered": Variant("b", True), "ProtocolVersion": Variant("i", 0)}

    async def _watcher_prop_get(self, m: Message) -> tuple[str, list[Any]]:
        props = self._watcher_props()
        if m.body[1] not in props:
            raise DBusError("org.freedesktop.DBus.Error.UnknownProperty", m.body[1])
        return "v", [props[m.body[1]]]

    async def _watcher_prop_get_all(self, _m: Message) -> tuple[str, list[Any]]:
        return "a{sv}", [self._watcher_props()]

    async def _tray_list(self, _m: Message) -> tuple[str, list[Any]]:
        rows = []
        for key, (owner, path) in list(self.items.items()):
            reply = await self.bus.call(Message(destination=owner, path=path, interface=PROPS, member="GetAll", signature="s", body=[ITEM_IFACE]))
            if reply.message_type != MessageType.METHOD_RETURN:
                continue
            p = {k: v.value for k, v in reply.body[0].items()}
            rows.append([key, str(p.get("Id", "")), str(p.get("Title", "")), str(p.get("IconName", "")), str(p.get("Status", "Active"))])
        return "a(sssss)", [rows]

    async def _tray_activate(self, m: Message) -> tuple[str, list[Any]]:
        key, x, y = m.body
        if key not in self.items:
            raise NotFound(f"no tray item {key!r}")
        owner, path = self.items[key]
        self.bus.send(Message(destination=owner, path=path, interface=ITEM_IFACE, member="Activate", signature="ii", body=[x, y]))
        return "", []
