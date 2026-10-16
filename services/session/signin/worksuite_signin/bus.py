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


class NotAuthorized(Exception):
    pass


async def dispatch(member, args, uid, authorized, run=subprocess.run, state=None, getpwuid=None):
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
