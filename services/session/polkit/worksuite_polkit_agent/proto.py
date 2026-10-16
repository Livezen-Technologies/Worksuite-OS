"""Shell-drawn polkit agent (G05, WSOS-INT-010): the parts without GObject, so they are unit tested.

The agent (agent.py) registers with polkitd for the session and talks to the shell over a Unix socket in
$XDG_RUNTIME_DIR, one JSON object per line:

  agent -> shell  {"type": "request", "id", "action_id", "message", "icon", "program", "user", "user_display", "attempts"}
                  {"type": "info", "id", "text", "error": bool}        PAM text (fingerprint prompts, faillock notices)
                  {"type": "result", "id", "ok": bool, "remaining": n|None, "locked_until": ms|None, "deny": n, "unlock_time": s}
                  {"type": "done", "id"}                                the request ended (success, cancel or polkit)
  shell -> agent  {"type": "respond", "id", "password"}  /  {"type": "cancel", "id"}

PAM (polkit-agent-helper-1) checks the password and pam_faillock enforces the lockout (WSOS-AUTH-004). The agent
counts the failures it sees against the same faillock.conf so the dialog can say how many tries are left and when the
lockout ends; it never decides on its own whether a password is right.
"""
import json
import os
import re
import time

FAILLOCK_CONFS = ("/etc/worksuite/faillock.conf", "/etc/security/faillock.conf")
# Same defaults as services/session/pam/faillock.conf and services/device-agent/src/enforce.ts.
DEFAULT_DENY, DEFAULT_UNLOCK = 5, 600
FRIENDLY = {"electron": "WorkSuite", "worksuite-shell": "WorkSuite", "worksuite-package-service": "App Center",
            "worksuite-device-agent": "WorkSuite device agent", "pkexec": "pkexec"}


def parse_faillock(text):
    """(deny, unlock_time seconds; 0 = until an administrator resets it) from faillock.conf text."""
    deny, unlock = DEFAULT_DENY, DEFAULT_UNLOCK
    for line in (text or "").splitlines():
        m = re.match(r"^\s*(deny|unlock_time)\s*=\s*(\d+)\s*(?:#.*)?$", line)
        if not m:
            continue
        if m.group(1) == "deny":
            deny = max(1, int(m.group(2)))
        else:
            unlock = int(m.group(2))
    return deny, unlock


def load_faillock(paths=FAILLOCK_CONFS):
    for p in paths:
        try:
            with open(p, encoding="utf-8") as f:
                return parse_faillock(f.read())
        except OSError:
            continue
    return DEFAULT_DENY, DEFAULT_UNLOCK


class Lockout:
    """Failures this agent has seen per user, mirroring pam_faillock's deny / unlock_time."""

    def __init__(self, deny, unlock_time, clock=time.time):
        self.deny, self.unlock_time, self.clock = deny, unlock_time, clock
        self.fails = {}  # user -> [timestamps]
        self.locked = {}  # user -> until (seconds; inf when an admin must reset)

    def state(self, user):
        until = self.locked.get(user)
        now = self.clock()
        if until is not None and now >= until:
            del self.locked[user]
            self.fails.pop(user, None)
            until = None
        remaining = None if until is not None else max(0, self.deny - len(self.fails.get(user, [])))
        return {"remaining": remaining, "locked_until": None if until is None else (None if until == float("inf") else int(until * 1000)),
                "locked": until is not None, "deny": self.deny, "unlock_time": self.unlock_time}

    def failed(self, user, pam_says_locked=False):
        now = self.clock()
        f = self.fails.setdefault(user, [])
        f.append(now)
        if pam_says_locked or len(f) >= self.deny:
            self.locked[user] = float("inf") if self.unlock_time == 0 else now + self.unlock_time
        return self.state(user)

    def succeeded(self, user):
        self.fails.pop(user, None)
        self.locked.pop(user, None)


LOCKED_RE = re.compile(r"(account|user).*(locked|temporarily)|locked due to|faillock", re.I)


def pam_says_locked(text):
    return bool(LOCKED_RE.search(text or ""))


def program_name(details, proc="/proc"):
    """Friendly name of the program asking, from polkit's details (subject pid), or None."""
    pid = None
    for k in ("polkit.subject-pid", "polkit.caller-pid"):
        v = (details or {}).get(k)
        if v and str(v).isdigit():
            pid = int(v)
            break
    if pid is None:
        return None
    try:
        with open(os.path.join(proc, str(pid), "comm"), encoding="utf-8") as f:
            comm = f.read().strip()
    except OSError:
        return None
    return FRIENDLY.get(comm, comm or None)


def pick_identity(identities, my_uid):
    """The identity to ask for: the person at the desk when they are an administrator, else the first offered.

    identities: [(uid, name, display)]."""
    if not identities:
        return None
    for i in identities:
        if i[0] == my_uid:
            return i
    return identities[0]


def encode(msg):
    return (json.dumps(msg, separators=(",", ":")) + "\n").encode("utf-8")


class LineReader:
    """Splits a byte stream into JSON objects; drops malformed or oversized lines."""

    MAX = 64 * 1024

    def __init__(self):
        self.buf = b""

    def feed(self, data):
        self.buf += data
        out = []
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            if not line.strip() or len(line) > self.MAX:
                continue
            try:
                m = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                continue
            if isinstance(m, dict) and isinstance(m.get("type"), str):
                out.append(m)
        if len(self.buf) > self.MAX:
            self.buf = b""
        return out
