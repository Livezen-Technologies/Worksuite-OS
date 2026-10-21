"""lk.worksuite.SignIn1 on the system bus (WSOS-ARC-002): Settings › Users › Sign-in options as named D-Bus methods,
each behind the polkit action lk.worksuite.signin.manage (auth_self: the person types their own password).

The user a call acts on is always the bus caller's UID (GetConnectionUnixUser), never an argument; the PIN is a
D-Bus argument, never argv or logs. Each method runs the same checks as the pkexec path (cli.manage), which this
replaces for the shell. D-Bus activated (dbus/lk.worksuite.SignIn1.service); exits after a minute idle.
"""
import asyncio
import io
import json
import subprocess

from . import cli, core

NAME = "lk.worksuite.SignIn1"
PATH = "/lk/worksuite/SignIn1"
ACTION = "lk.worksuite.signin.manage"

# method → (cli command, has a secret argument). Every method needs ACTION.
METHODS = {
    "SetPin": ("pin-set", True),
    "RemovePin": ("pin-remove", False),
    "AddKey": ("key-add", False),
    "RemoveKey": ("key-remove", False),
}
ACTIONS = {m: ACTION for m in METHODS}

# Served for org.freedesktop.DBus.Introspectable.Introspect (same as dbus/lk.worksuite.SignIn1.xml). #56/#57: this
# service answers with a raw message handler, so dbus-next had nothing exported to introspect and replied with an
# empty node; the shell's proxy then found no lk.worksuite.SignIn1 interface and every PIN or key change failed
# before polkit was even asked.
INTROSPECTION = """<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg name="xml" type="s" direction="out"/></method>
  </interface>
  <interface name="lk.worksuite.SignIn1">
    <method name="SetPin"><arg name="pin" type="s" direction="in"/><arg name="result" type="s" direction="out"/></method>
    <method name="RemovePin"><arg name="result" type="s" direction="out"/></method>
    <method name="AddKey"><arg name="name" type="s" direction="in"/><arg name="result" type="s" direction="out"/></method>
    <method name="RemoveKey"><arg name="id" type="s" direction="in"/><arg name="result" type="s" direction="out"/></method>
  </interface>
</node>
"""


def introspect(path):
    """Introspection XML for PATH and each of its parents (so tools can walk down to it), else None."""
    if path == PATH:
        return INTROSPECTION
    if PATH.startswith(path.rstrip("/") + "/"):
        child = PATH[len(path.rstrip("/")) + 1:].split("/")[0]
        return f'<node>\n  <node name="{child}"/>\n</node>\n'
    return None


class NotAuthorized(Exception):
    pass


async def dispatch(member, args, uid, authorized, run=subprocess.run, state=None, getpwuid=None, devices=None):
    """One call → the cli.manage result dict. authorized: awaitable polkit check for this caller."""
    if member not in METHODS:
        return {"ok": False, "error": "bad_request"}
    if uid == 0:
        return {"ok": False, "error": "not_allowed"}
    if not await authorized(ACTIONS[member]):
        raise NotAuthorized()
    cmd, secret = METHODS[member]
    argv = [cmd]
    stdin = io.BytesIO(b"")
    if member == "SetPin":
        stdin = io.BytesIO((args[0] if args and isinstance(args[0], str) else "").encode() + b"\n")
    elif member == "AddKey":
        argv += ["--name", args[0] if args and isinstance(args[0], str) else ""]
    elif member == "RemoveKey":
        argv += ["--id", args[0] if args and isinstance(args[0], str) else ""]
    kw = {"run": run, "state": state}
    if getpwuid is not None:
        kw["getpwuid"] = getpwuid
    if devices is not None:
        kw["devices"] = devices
    try:
        return cli.manage(argv, {"PKEXEC_UID": str(uid)}, stdin, 0, **kw)
    except core.SigninError as e:
        return {"ok": False, "error": e.code}
    except (OSError, subprocess.SubprocessError, KeyError):
        return {"ok": False, "error": "failed"}
    finally:
        stdin = None  # noqa: F841


def serve_bus(idle_seconds=60):  # pragma: no cover - needs a system bus; dispatch() is the tested part
    from dbus_next import BusType, Message, MessageType, Variant
    from dbus_next.aio import MessageBus

    async def main():
        bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        last = [asyncio.get_running_loop().time()]

        async def call(dest, path, iface, member, sig, body):
            r = await bus.call(Message(destination=dest, path=path, interface=iface, member=member, signature=sig, body=body))
            if r.message_type == MessageType.ERROR:
                raise RuntimeError(r.error_name)
            return r.body

        def handler(msg):
            if msg.interface == "org.freedesktop.DBus.Introspectable" and msg.member == "Introspect":
                xml = introspect(msg.path or "")
                return Message.new_method_return(msg, "s", [xml]) if xml else None
            if msg.path != PATH or msg.interface != NAME or msg.member not in METHODS:
                return None

            async def go():
                last[0] = asyncio.get_running_loop().time()
                try:
                    uid = int((await call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixUser", "s", [msg.sender]))[0])

                    async def authorized(action):
                        subject = ["system-bus-name", {"name": Variant("s", msg.sender)}]
                        r = await call("org.freedesktop.PolicyKit1", "/org/freedesktop/PolicyKit1/Authority", "org.freedesktop.PolicyKit1.Authority",
                                       "CheckAuthorization", "(sa{sv})sa{ss}us", [subject, action, {}, 1, ""])
                        return bool(r[0][0])
                    out = await dispatch(msg.member, msg.body, uid, authorized)
                    bus.send(Message.new_method_return(msg, "s", [json.dumps(out)]))
                except NotAuthorized:
                    bus.send(Message.new_error(msg, "lk.worksuite.Error.NotAuthorized", "not authorized"))
                except Exception:  # noqa: BLE001 - never leak details (or secrets) to the caller
                    bus.send(Message.new_error(msg, "lk.worksuite.Error.Failed", "failed"))
            asyncio.ensure_future(go())
            return True

        bus.add_message_handler(handler)
        await bus.request_name(NAME)
        while asyncio.get_running_loop().time() - last[0] < idle_seconds:
            await asyncio.sleep(5)
        bus.disconnect()

    asyncio.run(main())
