"""WorkSuite polkit authentication agent (G05, WSOS-INT-010): lets the shell draw the administrator prompt. Protocol
and lockout bookkeeping: proto.py. Run by worksuite-polkit-agent.

polkit itself is spoken by worksuite-polkit-listener (listener/), a small C PolkitAgentListener this agent runs with
pipes (protocol at the top of its source). A PyGObject subclass of PolkitAgent.Listener cannot work: PyGObject drops
the GAsyncReadyCallback's user_data on its way through Gio.Task, and libpolkit-agent-1's auth_cb then dereferenced
NULL (SIGSEGV at libpolkit-agent-1.so.0+0x5baa) at the end of every request, after a password and after a cancel.

When no shell is connected (it crashed or has not started yet) a request waits up to WAIT_FOR_SHELL seconds for it and
is then cancelled, which the requesting program reports as "not authorized".
"""
import os
import pwd
import socket
import sys
import uuid

import subprocess

from gi.repository import GLib

from . import proto

LISTENER = os.environ.get("WORKSUITE_POLKIT_LISTENER", "/usr/lib/worksuite/worksuite-polkit-listener")
WAIT_FOR_SHELL = 20


def log(msg):
    print(f"worksuite-polkit-agent: {msg}", file=sys.stderr, flush=True)


def socket_path():
    run = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(run, "worksuite-polkit.sock")


class Shell:
    """The single shell connection (the newest one wins)."""

    def __init__(self, agent):
        self.agent, self.conn, self.reader, self.watch = agent, None, None, None
        path = socket_path()
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        try:
            self.srv.bind(path)
        finally:
            os.umask(old)
        self.srv.listen(2)
        GLib.io_add_watch(self.srv.fileno(), GLib.IO_IN, self._accept)

    def _accept(self, *_a):
        c, _ = self.srv.accept()
        uid = c.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        if int.from_bytes(uid[4:8], sys.byteorder) != os.getuid():
            c.close()
            return True
        self.close()
        self.conn, self.reader = c, proto.LineReader()
        self.watch = GLib.io_add_watch(c.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self._read)
        self.agent.shell_connected()
        return True

    def _read(self, *_a):
        try:
            data = self.conn.recv(65536)
        except OSError:
            data = b""
        if not data:
            self.close()
            return False
        for m in self.reader.feed(data):
            self.agent.from_shell(m)
        return True

    def close(self):
        if self.watch:
            GLib.source_remove(self.watch)
            self.watch = None
        if self.conn:
            self.conn.close()
            self.conn = None

    def send(self, msg):
        if not self.conn:
            return False
        try:
            self.conn.sendall(proto.encode(msg))
            return True
        except OSError:
            self.close()
            return False


class Helper:
    """worksuite-polkit-listener on a pair of pipes."""

    def __init__(self, agent, argv):
        self.agent, self.buf = agent, b""
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
        GLib.io_add_watch(self.proc.stdout.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self._read)

    def _read(self, *_a):
        data = os.read(self.proc.stdout.fileno(), 65536)
        if not data:
            self.agent.helper_gone(self.proc.wait())
            return False
        self.buf += data
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            self.agent.from_helper(proto.split_fields(line.decode("utf-8", "replace")))
        return True

    def send(self, *fields):
        try:
            self.proc.stdin.write(proto.join_fields(fields).encode("utf-8"))
            self.proc.stdin.flush()
        except OSError as e:
            log(f"listener pipe: {e}")


class Request:
    def __init__(self, agent, hid, action_id, message, icon, details, identity):
        self.agent, self.hid = agent, hid
        self.id = uuid.uuid4().hex
        self.identity = identity  # (uid, name, display)
        self.msg = {"type": "request", "id": self.id, "action_id": action_id, "message": message, "icon": icon or "",
                    "program": proto.program_name(details), "user": identity[1], "user_display": identity[2]}
        self.open = True  # until returned to polkit
        self.running = False  # a PAM conversation is going on in the listener
        self.pending_password = None
        self.locked_text = False
        self.asking = False
        self.timer = None

    def payload(self):
        return {**self.msg, **self.agent.lockout.state(self.identity[1])}

    def start_session(self):
        self.asking = False
        self.running = True
        self.agent.helper.send("start", self.hid, self.identity[0])

    def on_request(self):
        if self.pending_password is not None:
            pw, self.pending_password = self.pending_password, None
            self.agent.helper.send("respond", self.hid, pw)
        else:
            self.asking = True  # answered when the shell sends "respond"

    def on_error(self, text):
        if proto.pam_says_locked(text):
            self.locked_text = True
        self.agent.shell.send({"type": "info", "id": self.id, "text": text, "error": True})

    def on_completed(self, gained):
        self.running = self.asking = False
        user = self.identity[1]
        if gained:
            self.agent.lockout.succeeded(user)
            self.agent.shell.send({"type": "result", "id": self.id, "ok": True})
            self.finish("ok")
            return
        st = self.agent.lockout.failed(user, self.locked_text)
        self.locked_text = False
        self.agent.shell.send({"type": "result", "id": self.id, "ok": False, **st})
        # Ready for the next try (PAM keeps refusing while faillock holds the lock).
        if self.open:
            self.start_session()

    def respond(self, password):
        if not self.running:
            self.start_session()
        if self.asking:
            self.asking = False
            self.agent.helper.send("respond", self.hid, password)
        else:
            self.pending_password = password  # on_request answers when PAM asks

    def cancel(self):
        self.finish("cancel")

    def finish(self, how, tell_listener=True):
        """how: ok, cancel or fail. tell_listener=False when polkit already withdrew the request."""
        if not self.open:
            return
        self.open = False
        if self.timer:
            GLib.source_remove(self.timer)
            self.timer = None
        if tell_listener:
            self.agent.helper.send("finish", self.hid, how)
        self.agent.shell.send({"type": "done", "id": self.id})
        self.agent.requests.pop(self.id, None)


def identities_of(uids):
    out = []
    for uid in uids:
        try:
            p = pwd.getpwuid(uid)
            out.append((uid, p.pw_name, (p.pw_gecos.split(",")[0] or p.pw_name)))
        except KeyError:
            continue
    return out


class Agent:
    def __init__(self, listener_argv, shell=True):
        self.lockout = proto.Lockout(*proto.load_faillock())
        self.requests = {}  # shell id -> Request
        self.by_hid = {}  # listener id -> Request
        self.details = {}  # listener id -> {key: value} until "begin"
        self.loop = GLib.MainLoop()
        self.exit_code = 0
        self.shell = Shell(self) if shell else None
        self.helper = Helper(self, listener_argv) if listener_argv else None

    def from_helper(self, f):
        kind, hid = f[0], (f[1] if len(f) > 1 else "")
        if kind == "ready":
            log("registered")
        elif kind == "fatal":
            log(f"could not register: {hid}")
        elif kind == "detail" and len(f) >= 4:
            self.details.setdefault(hid, {})[f[2]] = f[3]
        elif kind == "begin" and len(f) >= 6:
            self.begin(hid, f[2], f[3], f[4], self.details.pop(hid, {}), [int(u) for u in f[5].split(",") if u.isdigit()])
        else:
            r = self.by_hid.get(hid)
            if r is None or not r.open:
                return
            if kind == "request":
                r.on_request()
            elif kind == "info" and len(f) >= 3:
                self.shell.send({"type": "info", "id": r.id, "text": f[2], "error": False})
            elif kind == "error" and len(f) >= 3:
                r.on_error(f[2])
            elif kind == "completed" and len(f) >= 3:
                r.on_completed(f[2] == "1")
            elif kind == "cancelled":
                r.finish("cancel", tell_listener=False)
            if not r.open:
                self.by_hid.pop(hid, None)

    def begin(self, hid, action_id, message, icon, details, uids):
        ident = proto.pick_identity(identities_of(uids), os.getuid())
        if ident is None:
            self.helper.send("finish", hid, "fail")
            return
        r = Request(self, hid, action_id, message, icon, details, ident)
        self.requests[r.id], self.by_hid[hid] = r, r
        r.start_session()
        if not self.shell.send(r.payload()):
            log(f"{action_id}: waiting for the shell")
            r.timer = GLib.timeout_add_seconds(WAIT_FOR_SHELL, lambda: (r.cancel(), False)[1])

    def helper_gone(self, code):
        log(f"listener exited ({code})")
        self.exit_code = code or 1
        self.loop.quit()

    def shell_connected(self):
        for r in self.requests.values():
            if r.timer:
                GLib.source_remove(r.timer)
                r.timer = None
            self.shell.send(r.payload())

    def from_shell(self, m):
        r = self.requests.get(m.get("id"))
        if r is None:
            return
        if m["type"] == "respond" and isinstance(m.get("password"), str):
            if self.lockout.state(r.identity[1])["locked"]:
                self.shell.send({"type": "result", "id": r.id, "ok": False, **self.lockout.state(r.identity[1])})
                return
            r.respond(m["password"])
        elif m["type"] == "cancel":
            r.cancel()


def main(argv=None):
    """argv: extra listener arguments (--process PID for the integration test)."""
    argv = sys.argv[1:] if argv is None else argv
    agent = Agent([LISTENER, *argv])
    agent.loop.run()
    return agent.exit_code


if __name__ == "__main__":
    sys.exit(main())
