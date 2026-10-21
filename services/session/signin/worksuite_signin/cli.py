"""worksuite-signin: one helper, four ways in. The PIN is only ever read from stdin or the socket, never argv.

  PAM (pam_exec, see services/session/pam/worksuite-signin-*), run as root by greetd/polkit or as the user by gtklock:
    pam-pin        expose_authtok: the typed secret on stdin; asks the daemon; exit 0 = right PIN
    pam-not-pin    expose_authtok: exit 0 when the typed secret cannot be a PIN (a password), so the stack skips pam-pin
    pam-password-used  exit 0 when this sign-in did not use the PIN (the keyring profile then runs pam_gnome_keyring)
    pam-pin-used   the opposite answer (kept for profiles written before pam-password-used)
    pam-reset      after a successful root-context sign-in: wrong-PIN count back to 0 (ignored from non-root callers)
  pam_exec logs every non-zero exit at error level, so the answer for the common case (a password) is always 0.
  Daemon (worksuite-signin.socket, Accept=yes, root):
    serve          one JSON request on stdin (the connection); the caller is identified by SO_PEERCRED
  Settings (pkexec, polkit action lk.worksuite.signin.manage = auth_self; the user is PKEXEC_UID, never an argument):
    pin-set        new PIN on stdin
    pin-remove
    key-add --name NAME      runs pamu2fcfg, touch the key (refused with key_not_found when no FIDO device is attached)
    key-remove --id ID
  Lock screen (worksuite-lock, as the user):
    has-pin        exit 0 when the calling user has a device PIN (gtklock's field then says "PIN or password")
  Shell (socket, no prompt):
    {"op":"set_default","method":"password|pin|key"} for the calling user.
"""
import json
import os
import pwd
import re
import socket
import struct
import subprocess
import sys

from . import core

SOCK = os.environ.get("WORKSUITE_SIGNIN_SOCK", "/run/worksuite-signin.sock")
PAM_AUTH_UPDATE = os.environ.get("WORKSUITE_PAM_AUTH_UPDATE", "/usr/sbin/pam-auth-update")
PAMU2FCFG = os.environ.get("WORKSUITE_PAMU2FCFG", "/usr/bin/pamu2fcfg")
ORIGIN = "pam://worksuite"
PROFILE_PIN = ("worksuite-signin-pin", "worksuite-signin-pin-final")
PROFILE_KEY = ("worksuite-signin-u2f",)
MAX_REQ = 4096


# ---- daemon ----

def handle(req, peer_uid, getpwnam=pwd.getpwnam, state=None, run=None, pol=None):
    """One request from a peer. Returns a JSON-able reply; never echoes the PIN."""
    if not isinstance(req, dict):
        return {"ok": False, "error": "bad_request"}
    op, user = req.get("op"), req.get("user")
    if not isinstance(user, str) or not user or len(user) > 256:
        return {"ok": False, "error": "bad_request"}
    try:
        uid = getpwnam(user).pw_uid
    except KeyError:
        return {"ok": False, "error": "no_user"}
    if peer_uid != 0 and peer_uid != uid:
        return {"ok": False, "error": "not_allowed"}
    pol = pol or core.policy()
    if op == "verify":
        r = core.verify_pin(uid, req.get("pin"), pol, state, run)
        return {"ok": r == "ok", "result": r}
    if op == "pin_used":
        return {"ok": core.consume_pin_used(uid, run)}
    if op == "reset":
        if peer_uid != 0:
            return {"ok": False, "error": "not_allowed"}
        core.reset_failures(uid, state)
        return {"ok": True}
    if op == "status":
        return {"ok": True, "tries_left": core.tries_left(uid, pol, state), "policy": pol, "has_pin": core.read_pin(uid, state) is not None}
    if op == "set_default":
        try:
            core.set_default(user, req.get("method"), state)
        except core.SigninError as e:
            return {"ok": False, "error": e.code}
        return {"ok": True}
    return {"ok": False, "error": "bad_request"}


def peer_uid(sock):
    creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", creds)
    return uid


def _read_line(sock):
    buf = b""
    while b"\n" not in buf and len(buf) < MAX_REQ:
        chunk = sock.recv(MAX_REQ - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf.split(b"\n", 1)[0]


def serve(sock):
    try:
        raw = _read_line(sock)
        try:
            req = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            req = None
        reply = handle(req, peer_uid(sock))
        req = raw = None  # noqa: F841 (drop the PIN)
        sock.sendall((json.dumps(reply) + "\n").encode())
    finally:
        sock.close()


def ask(req, path=None, timeout=10.0):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(path or SOCK)
        s.sendall((json.dumps(req) + "\n").encode())
        return json.loads(_read_line(s).decode() or "{}")
    finally:
        s.close()


# ---- PAM side ----

def read_secret(stream):
    """pam_exec expose_authtok writes the token NUL-terminated; pkexec callers end it with a newline."""
    data = stream.read(MAX_REQ)
    if isinstance(data, bytes):
        data = data.decode("utf-8", "replace")
    return data.split("\0", 1)[0].rstrip("\r\n")


def is_pin_shaped(secret):
    return bool(secret) and secret.isascii() and secret.isdigit()


def pam_not_pin(env, stdin):
    """0 for a password (the PIN check is skipped, nothing is sent or counted); 1 when pam-pin should look at it."""
    secret = read_secret(stdin)
    try:
        return 1 if env.get("PAM_USER") and is_pin_shaped(secret) else 0
    finally:
        secret = None  # noqa: F841


def pam_password_used(env, sock=None):
    """0 unless the daemon says this sign-in used the PIN; an unreachable daemon keeps the keyring step (as before)."""
    user = env.get("PAM_USER")
    if not user:
        return 0
    try:
        return 1 if ask({"op": "pin_used", "user": user}, sock).get("ok") is True else 0
    except (OSError, ValueError):
        return 0


def has_pin(env, sock=None):
    """For the lock screen's label: 0 when the calling user (never another) has a PIN set; 1 otherwise or on error."""
    try:
        user = pwd.getpwuid(os.getuid()).pw_name
        return 0 if ask({"op": "status", "user": user}, sock).get("has_pin") is True else 1
    except (OSError, ValueError, KeyError):
        return 1


def pam_pin(env, stdin, sock=None):
    user = env.get("PAM_USER")
    if not user:
        return 1
    pin = read_secret(stdin)
    if not is_pin_shaped(pin):
        return 1  # a password typed in the same field: not a PIN, nothing sent, nothing counted
    try:
        r = ask({"op": "verify", "user": user, "pin": pin}, sock)
    except (OSError, ValueError):
        return 1
    finally:
        pin = None  # noqa: F841
    return 0 if r.get("ok") is True else 1


def pam_simple(op, env, sock=None):
    user = env.get("PAM_USER")
    if not user:
        return 1
    try:
        return 0 if ask({"op": op, "user": user}, sock).get("ok") is True else 1
    except (OSError, ValueError):
        return 1


# ---- Settings side (pkexec) ----

def caller(env, euid, getpwuid=pwd.getpwuid):
    """The user a pkexec request is for: always PKEXEC_UID, never an argument."""
    if euid != 0:
        raise core.SigninError("not_root")
    v = env.get("PKEXEC_UID")
    if not v or not v.isdigit():
        raise core.SigninError("not_pkexec")
    p = getpwuid(int(v))
    if p.pw_uid == 0:
        raise core.SigninError("not_allowed")
    return p.pw_name, p.pw_uid


def pam_profile(names, on, run=subprocess.run):
    """Profiles are off by default (pam-configs "Default: no") and on only while someone has the method set up."""
    run([PAM_AUTH_UPDATE, "--enable" if on else "--disable", *names],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def manage(argv, env, stdin, euid, run=subprocess.run, state=None, getpwuid=pwd.getpwuid, devices=core.fido_devices):
    cmd = argv[0]
    user, uid = caller(env, euid, getpwuid)
    if cmd == "pin-set":
        pin = read_secret(stdin)
        try:
            core.set_pin(uid, pin, core.policy(), state)
        finally:
            pin = None  # noqa: F841
        core.update_user(user, lambda u: u.__setitem__("pin", True), state)
        pam_profile(PROFILE_PIN, True, run)
    elif cmd == "pin-remove":
        core.remove_pin(uid, state)
        core.update_user(user, lambda u: u.__setitem__("pin", False), state)
        if not core.any_pin(state):
            pam_profile(PROFILE_PIN, False, run)
    elif cmd == "key-add":
        name = argv[argv.index("--name") + 1] if "--name" in argv[:-1] else ""
        # #57: say "plug in your key" instead of a generic failure when no FIDO device is attached at all.
        if not devices():
            raise core.SigninError("key_not_found")
        try:
            r = run([PAMU2FCFG, "-n", "-u", user, "-o", ORIGIN, "-i", ORIGIN], stdin=subprocess.DEVNULL,
                    capture_output=True, text=True, timeout=90, check=False)
        except subprocess.TimeoutExpired:
            raise core.SigninError("key_timeout") from None
        except FileNotFoundError:
            raise core.SigninError("key_unavailable") from None  # pamu2fcfg (package pamu2fcfg) is not installed
        if r.returncode != 0:
            raise core.SigninError(core.pamu2fcfg_error(r.returncode, r.stderr))
        kid = core.add_key(user, core.parse_pamu2fcfg(r.stdout), name, state)
        pam_profile(PROFILE_KEY, True, run)
        return {"ok": True, "id": kid}
    elif cmd == "key-remove":
        kid = argv[argv.index("--id") + 1] if "--id" in argv[:-1] else ""
        if not re.fullmatch(r"[0-9a-f]{16}", kid):
            raise core.SigninError("bad_request")
        core.remove_key(user, kid, state)
        if not core.any_key(state):
            pam_profile(PROFILE_KEY, False, run)
    else:
        raise core.SigninError("bad_request")
    return {"ok": True}


def main(argv=None, env=None, stdin=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if env is None else env
    stdin = sys.stdin.buffer if stdin is None else stdin
    if not argv:
        print("usage: worksuite-signin pam-pin|pam-not-pin|pam-password-used|pam-pin-used|pam-reset|serve|dbus|pin-set|pin-remove|key-add|key-remove", file=sys.stderr)
        return 2
    cmd = argv[0]
    if cmd == "pam-pin":
        return pam_pin(env, stdin)
    if cmd == "has-pin":
        return has_pin(env)
    if cmd == "pam-not-pin":
        return pam_not_pin(env, stdin)
    if cmd == "pam-password-used":
        return pam_password_used(env)
    if cmd == "pam-pin-used":
        return pam_simple("pin_used", env)
    if cmd == "pam-reset":
        pam_simple("reset", env)
        return 0  # optional and best effort: a non-root caller or a stopped daemon is not an error worth logging
    if cmd == "dbus":
        if env.get("PKEXEC_UID") or os.geteuid() != 0:
            return 1
        from .bus import serve_bus
        serve_bus()
        return 0
    if cmd == "serve":
        if env.get("PKEXEC_UID"):
            return 1
        serve(socket.socket(fileno=0))
        return 0
    try:
        out = manage(argv, env, stdin, os.geteuid())
    except core.SigninError as e:
        out = {"ok": False, "error": e.code}
    except (OSError, subprocess.SubprocessError, KeyError):
        out = {"ok": False, "error": "failed"}
    print(json.dumps(out))
    return 0 if out.get("ok") else 1
