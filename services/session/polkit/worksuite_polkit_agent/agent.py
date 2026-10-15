"""WorkSuite polkit authentication agent (G05, WSOS-INT-010): registers for this login session and lets the shell draw
the administrator prompt. Protocol and lockout bookkeeping: proto.py. Run by worksuite-polkit-agent.

When no shell is connected (it crashed or has not started yet) a request waits up to WAIT_FOR_SHELL seconds for it and
is then cancelled, which the requesting program reports as "not authorized".
"""
import os
import pwd
import socket
import sys
import uuid

import gi

gi.require_version("Polkit", "1.0")
gi.require_version("PolkitAgent", "1.0")
from gi.repository import Gio, GLib, Polkit, PolkitAgent  # noqa: E402

from . import proto  # noqa: E402

OBJECT_PATH = "/lk/worksuite/PolkitAgent"
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


class Request:
    def __init__(self, agent, task, action_id, message, icon, details, cookie, identity):
        self.agent, self.task, self.cookie = agent, task, cookie
        self.id = uuid.uuid4().hex
        self.identity = identity  # (uid, name, display)
        self.unix_user = Polkit.UnixUser.new(identity[0])
        self.msg = {"type": "request", "id": self.id, "action_id": action_id, "message": message, "icon": icon or "",
                    "program": proto.program_name(details), "user": identity[1], "user_display": identity[2]}
        self.session = None
        self.pending_password = None
        self.locked_text = False
        self.asking = False
        self.timer = None

    def payload(self):
        return {**self.msg, **self.agent.lockout.state(self.identity[1])}

    def start_session(self):
        self.asking = False
        s = PolkitAgent.Session.new(self.unix_user, self.cookie)
        s.connect("request", self._on_request)
        s.connect("show-info", lambda _s, t: self.agent.shell.send({"type": "info", "id": self.id, "text": t, "error": False}))
        s.connect("show-error", self._on_error)
        s.connect("completed", self._on_completed)
        self.session = s
        s.initiate()

    def _on_request(self, s, _prompt, _echo):
        if self.pending_password is not None:
            pw, self.pending_password = self.pending_password, None
            s.response(pw)
        else:
            self.asking = True  # answered when the shell sends "respond"

    def _on_error(self, _s, text):
        if proto.pam_says_locked(text):
            self.locked_text = True
        self.agent.shell.send({"type": "info", "id": self.id, "text": text, "error": True})

    def _on_completed(self, s, gained):
        self.session = None
        user = self.identity[1]
        if gained:
            self.agent.lockout.succeeded(user)
            self.agent.shell.send({"type": "result", "id": self.id, "ok": True})
            self.finish(None)
            return
        st = self.agent.lockout.failed(user, self.locked_text)
        self.locked_text = False
        self.agent.shell.send({"type": "result", "id": self.id, "ok": False, **st})
        self.start_session()  # ready for the next try (PAM keeps refusing while faillock holds the lock)

    def respond(self, password):
        if self.session is None:
            self.start_session()
        if self.asking:
            self.asking = False
            self.session.response(password)
        else:
            self.pending_password = password  # _on_request answers when PAM asks

    def cancel(self):
        self.finish(GLib.Error.new_literal(Polkit.error_quark(), "Authentication was cancelled", int(Polkit.Error.CANCELLED)))

    def finish(self, error):
        if self.task is None:
            return
        if self.timer:
            GLib.source_remove(self.timer)
            self.timer = None
        if self.session is not None:
            self.session.cancel()
            self.session = None
        task, self.task = self.task, None
        if error is None:
            task.return_boolean(True)
        else:
            task.return_error(error)
        self.agent.shell.send({"type": "done", "id": self.id})
        self.agent.requests.pop(self.id, None)


def identities_of(polkit_identities):
    out = []
    for i in polkit_identities:
        if isinstance(i, Polkit.UnixUser):
            uid = i.get_uid()
            try:
                p = pwd.getpwuid(uid)
                out.append((uid, p.pw_name, (p.pw_gecos.split(",")[0] or p.pw_name)))
            except KeyError:
                continue
    return out


class Listener(PolkitAgent.Listener):
    def __init__(self):
        super().__init__()
        self.lockout = proto.Lockout(*proto.load_faillock())
        self.requests = {}
        self.shell = Shell(self)

    def do_initiate_authentication(self, action_id, message, icon_name, details, cookie, identities, cancellable, callback, user_data):
        task = Gio.Task.new(self, cancellable, callback, user_data)
        d = {k: details.lookup(k) for k in details.get_keys()} if details else {}
        ident = proto.pick_identity(identities_of(identities), os.getuid())
        if ident is None:
            task.return_error(GLib.Error.new_literal(Polkit.error_quark(), "No identity to authenticate as", int(Polkit.Error.FAILED)))
            return
        r = Request(self, task, action_id, message, icon_name, d, cookie, ident)
        self.requests[r.id] = r
        if cancellable:
            cancellable.connect(lambda *_a: GLib.idle_add(lambda: (r.finish(GLib.Error.new_literal(Polkit.error_quark(), "Cancelled by polkit", int(Polkit.Error.CANCELLED))), False)[1]))
        r.start_session()
        if not self.shell.send(r.payload()):
            log(f"{action_id}: waiting for the shell")
            r.timer = GLib.timeout_add_seconds(WAIT_FOR_SHELL, lambda: (r.cancel(), False)[1])

    def do_initiate_authentication_finish(self, res):
        return res.propagate_boolean()

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


def main():
    try:
        subject = Polkit.UnixSession.new_for_process_sync(os.getpid(), None)
    except GLib.Error as e:
        log(f"no login session: {e.message}")
        return 1
    if subject is None:
        log("no login session")
        return 1
    listener = Listener()
    try:
        listener.register(PolkitAgent.RegisterFlags.NONE, subject, OBJECT_PATH, None)
    except GLib.Error as e:
        log(f"could not register: {e.message}")
        return 1
    log("registered")
    GLib.MainLoop().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
