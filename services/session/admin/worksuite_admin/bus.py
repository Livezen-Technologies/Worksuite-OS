"""lk.worksuite.Admin1 on the system bus (WSOS-ARC-002): the shell's last root helpers as named D-Bus methods.

Each method has its own polkit action, checked with CheckAuthorization for the calling bus name; the user a call acts
for is always the bus caller's UID (GetConnectionUnixUser), never an argument. Every argument is checked against an
allow-list here, then the fixed helper runs with an argument array (no shell), a clean environment and the caller's
UID in WORKSUITE_CALLER_UID. The helpers check their arguments again. This replaces pkexec for the shell (kiosk exit,
Recovery › Reinstall, printer administration, "Restart anyway", Settings › About › Diagnostics).

D-Bus activated (dbus/lk.worksuite.Admin1.service); exits after a minute idle with nothing running. Every method
returns (code, output): the helper's exit status and its standard output (empty for helpers whose output the shell
does not show; for printer administration, CUPS's message when it failed). A refused polkit check is the error lk.worksuite.Error.NotAuthorized, a dismissed prompt
lk.worksuite.Error.Cancelled, an argument outside the allow-list lk.worksuite.Error.InvalidArgs.
"""
import asyncio
import os
import re

NAME = "lk.worksuite.Admin1"
PATH = "/lk/worksuite/Admin1"

KIOSK_EXIT = "/usr/lib/worksuite/worksuite-kiosk-exit"
REINSTALL = "/usr/libexec/worksuite/worksuite-reinstall"
PRINTER_ADMIN = "/usr/lib/worksuite/worksuite-printer-admin"
POWER_FORCE = "/usr/lib/worksuite/worksuite-power-force"
DIAGNOSTICS = "/usr/lib/worksuite/worksuite-diagnostics"
HELPERS = (KIOSK_EXIT, REINSTALL, PRINTER_ADMIN, POWER_FORCE, DIAGNOSTICS)

# worksuite-power-force exits with this when someone else would be affected: the service then asks for
# lk.worksuite.power-force-admin and runs it again with WORKSUITE_ADMIN_AUTHORIZED=1.
NEEDS_ADMIN = 10

# method → D-Bus input signature. Each returns (i code, s output).
SIGNATURES = {
    "KioskExit": "ss",
    "Reinstall": "a{ss}",
    "Printers": "as",
    "ForcePower": "s",
    "Journal": "su",
    "BootDetails": "s",
}

INTROSPECTION = """<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg name="xml" type="s" direction="out"/></method>
  </interface>
  <interface name="lk.worksuite.Admin1">
    <method name="KioskExit"><arg name="mode" type="s" direction="in"/><arg name="pin" type="s" direction="in"/><arg name="code" type="i" direction="out"/><arg name="output" type="s" direction="out"/></method>
    <method name="Reinstall"><arg name="options" type="a{ss}" direction="in"/><arg name="code" type="i" direction="out"/><arg name="output" type="s" direction="out"/></method>
    <method name="Printers"><arg name="args" type="as" direction="in"/><arg name="code" type="i" direction="out"/><arg name="output" type="s" direction="out"/></method>
    <method name="ForcePower"><arg name="action" type="s" direction="in"/><arg name="code" type="i" direction="out"/><arg name="output" type="s" direction="out"/></method>
    <method name="Journal"><arg name="kind" type="s" direction="in"/><arg name="lines" type="u" direction="in"/><arg name="code" type="i" direction="out"/><arg name="output" type="s" direction="out"/></method>
    <method name="BootDetails"><arg name="op" type="s" direction="in"/><arg name="code" type="i" direction="out"/><arg name="output" type="s" direction="out"/></method>
  </interface>
</node>
"""


class InvalidArgs(Exception):
    pass


class NotAuthorized(Exception):
    pass


class Cancelled(Exception):
    pass


class Call:
    """A checked request: polkit action, helper argv, stdin bytes, whether the output goes back to the caller, and
    whether its error message does when it fails (CUPS's reason, which Settings › Printers shows)."""

    def __init__(self, action, argv, stdin=b"", output=False, errors=False):
        self.action, self.argv, self.stdin, self.output, self.errors = action, argv, stdin, output, errors


def _str(v, pattern, maxlen):
    if not isinstance(v, str) or len(v) > maxlen or not re.fullmatch(pattern, v):
        raise InvalidArgs()
    return v


def _plain(v, maxlen):
    """A non-empty value without control characters (the printer helper checks its exact shape again)."""
    if not isinstance(v, str) or not v or len(v) > maxlen or re.search(r"[\x00-\x1f\x7f]", v):
        raise InvalidArgs()
    return v


ARITY = {"KioskExit": 2, "Reinstall": 1, "Printers": 1, "ForcePower": 1, "Journal": 2, "BootDetails": 1}
REINSTALL_KEYS = {"mode", "disk", "confirm"}
PRINTER_NAME = r"[A-Za-z0-9_][A-Za-z0-9_-]*"


def validate(member, args, sys_block="/sys/block"):
    """member + D-Bus body → Call, or InvalidArgs for anything outside the allow-list."""
    if member not in SIGNATURES or not isinstance(args, (list, tuple)) or len(args) != ARITY[member]:
        raise InvalidArgs()
    if member == "KioskExit":
        mode, pin = args
        if mode == "pin":
            return Call("lk.worksuite.kiosk.exit-pin", [KIOSK_EXIT, "--pin"], _str(pin, r"[0-9]{4,12}", 12).encode() + b"\n")
        if mode == "admin" and pin == "":
            return Call("lk.worksuite.kiosk.exit-admin", [KIOSK_EXIT, "--admin"])
        raise InvalidArgs()
    if member == "Reinstall":
        o = args[0]
        if not isinstance(o, dict) or not set(o) <= REINSTALL_KEYS or "mode" not in o or "disk" not in o:
            raise InvalidArgs()
        disk = _str(o["disk"], r"[A-Za-z0-9][A-Za-z0-9._-]*", 32)
        if not os.path.isdir(os.path.join(sys_block, disk)):
            raise InvalidArgs()   # a whole disk the kernel knows, not a partition or a path
        argv = [REINSTALL, "--mode", o["mode"], "--disk", disk]
        if o["mode"] == "keep":
            if "confirm" in o:
                raise InvalidArgs()
        elif o["mode"] == "erase":
            if o.get("confirm") != disk:
                raise InvalidArgs()   # typed confirmation, checked again by the script
            argv += ["--confirm", disk]
        else:
            raise InvalidArgs()
        return Call("lk.worksuite.recovery.reinstall", argv)
    if member == "Printers":
        a = args[0]
        if not isinstance(a, (list, tuple)) or not a or not all(isinstance(x, str) for x in a):
            raise InvalidArgs()
        op, rest = a[0], list(a[1:])
        if op == "devices" and not rest:
            out = True
        elif op == "drivers" and len(rest) == 2 and rest[0] in ("id", "mm"):
            _plain(rest[1], 1024)
            out = True
        elif op == "add" and len(rest) == 4:
            _str(rest[0], PRINTER_NAME, 127)
            _plain(rest[1], 512)
            _plain(rest[2], 512)
            _plain(rest[3], 255)
            out = False
        elif op in ("remove", "pause", "resume") and len(rest) == 1:
            _str(rest[0], PRINTER_NAME, 127)
            out = False
        else:
            raise InvalidArgs()
        return Call("lk.worksuite.printers", [PRINTER_ADMIN, op, *rest], output=out, errors=True)
    if member == "ForcePower":
        if args[0] not in ("reboot", "poweroff"):
            raise InvalidArgs()
        return Call("lk.worksuite.power-force", [POWER_FORCE, args[0]])
    if member == "Journal":
        kind, lines = args
        if kind not in ("boot", "previous", "greeter") or isinstance(lines, bool) or not isinstance(lines, int) or not 1 <= lines <= 5000:
            raise InvalidArgs()
        return Call("lk.worksuite.diagnostics", [DIAGNOSTICS, "journal", kind, str(lines)], output=True)
    # BootDetails. Reading the flag needs no service: the shell reads the file itself.
    if args[0] not in ("on", "off"):
        raise InvalidArgs()
    return Call("lk.worksuite.diagnostics", [DIAGNOSTICS, "boot-details", args[0]], output=True)


def helper_env(uid, admin=False):
    """The helpers' whole environment: nothing from the caller, nothing that redirects them (WORKSUITE_* overrides)."""
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "WORKSUITE_CALLER_UID": str(uid)}
    if admin:
        env["WORKSUITE_ADMIN_AUTHORIZED"] = "1"
    return env


async def run_helper(argv, stdin, env):  # pragma: no cover - exercised on a system; dispatch() takes it as a parameter
    p = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                             stderr=asyncio.subprocess.PIPE, env=env, close_fds=True)
    out, err = await p.communicate(stdin)
    return p.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _check(verdict):
    if verdict == "dismissed":
        raise Cancelled()
    if verdict != "yes":
        raise NotAuthorized()


async def dispatch(member, args, uid, authorize, run=run_helper, exists=os.path.exists, sys_block="/sys/block"):
    """One call → (code, output). authorize(action) → "yes" | "no" | "dismissed" for this caller (polkit)."""
    c = validate(member, args, sys_block)
    if uid == 0 and member == "KioskExit":
        raise InvalidArgs()   # root is never the kiosk account
    _check(await authorize(c.action))
    if not exists(c.argv[0]):
        return 127, ""
    code, out, err = await run(c.argv, c.stdin, helper_env(uid))
    if member == "ForcePower" and code == NEEDS_ADMIN:
        _check(await authorize("lk.worksuite.power-force-admin"))
        code, out, err = await run(c.argv, c.stdin, helper_env(uid, admin=True))
    if code != 0 and c.errors:
        return code, err[:2000]
    return code, out if c.output else ""


def introspect(path):
    """Introspection XML for PATH and each of its parents (so tools can walk down to it), else None."""
    if path == PATH:
        return INTROSPECTION
    if PATH.startswith(path.rstrip("/") + "/"):
        child = PATH[len(path.rstrip("/")) + 1:].split("/")[0]
        return f'<node>\n  <node name="{child}"/>\n</node>\n'
    return None


def verdict(reply):
    """CheckAuthorization's (bba{ss}) → "yes" | "dismissed" | "no"."""
    ok, _challenge, details = reply
    if ok:
        return "yes"
    return "dismissed" if dict(details or {}).get("polkit.dismissed") == "true" else "no"


def serve_bus(idle_seconds=60):  # pragma: no cover - needs a system bus; dispatch() is the tested part
    from dbus_next import BusType, Message, MessageType, Variant
    from dbus_next.aio import MessageBus

    async def main():
        bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        loop = asyncio.get_running_loop()
        last = [loop.time()]
        busy = [0]

        async def call(dest, path, iface, member, sig, body):
            r = await bus.call(Message(destination=dest, path=path, interface=iface, member=member, signature=sig, body=body))
            if r.message_type == MessageType.ERROR:
                raise RuntimeError(r.error_name)
            return r.body

        def handler(msg):
            if msg.interface == "org.freedesktop.DBus.Introspectable" and msg.member == "Introspect":
                xml = introspect(msg.path or "")
                return Message.new_method_return(msg, "s", [xml]) if xml else None
            if msg.path != PATH or msg.interface != NAME or msg.member not in SIGNATURES:
                return None
            if msg.signature != SIGNATURES[msg.member]:
                return Message.new_error(msg, "lk.worksuite.Error.InvalidArgs", "invalid arguments")

            async def go():
                busy[0] += 1
                try:
                    uid = int((await call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixUser", "s", [msg.sender]))[0])

                    async def authorize(action):
                        subject = ["system-bus-name", {"name": Variant("s", msg.sender)}]
                        r = await call("org.freedesktop.PolicyKit1", "/org/freedesktop/PolicyKit1/Authority", "org.freedesktop.PolicyKit1.Authority",
                                       "CheckAuthorization", "(sa{sv})sa{ss}us", [subject, action, {}, 1, ""])
                        return verdict(r[0])
                    code, out = await dispatch(msg.member, list(msg.body), uid, authorize)
                    bus.send(Message.new_method_return(msg, "is", [code, out]))
                except InvalidArgs:
                    bus.send(Message.new_error(msg, "lk.worksuite.Error.InvalidArgs", "invalid arguments"))
                except NotAuthorized:
                    bus.send(Message.new_error(msg, "lk.worksuite.Error.NotAuthorized", "not authorized"))
                except Cancelled:
                    bus.send(Message.new_error(msg, "lk.worksuite.Error.Cancelled", "cancelled"))
                except Exception:  # noqa: BLE001 - never leak details (or the PIN) to the caller
                    bus.send(Message.new_error(msg, "lk.worksuite.Error.Failed", "failed"))
                finally:
                    busy[0] -= 1
                    last[0] = loop.time()
            asyncio.ensure_future(go())
            return True

        bus.add_message_handler(handler)
        await bus.request_name(NAME)
        while busy[0] or loop.time() - last[0] < idle_seconds:
            await asyncio.sleep(5)
        bus.disconnect()

    asyncio.run(main())
