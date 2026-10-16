"""Device PIN and FIDO2 security-key sign-in for WorkSuite OS (boards AuthMethods, AuthPin, AuthPasskey, AuthLockPin).

Security model (see services/session/signin/README.md):
- The PIN is local to this device. Only an scrypt verifier is kept, in a root-only file per user
  (/var/lib/worksuite/signin/pin/<uid>.json, 0600, directory 0700). The PIN itself is never written, logged or put
  in argv; it travels on stdin (pkexec, pam_exec) or over the root daemon's Unix socket.
- PIN sign-in is a PAM method (pam_exec, see pam/worksuite-signin-pin). It never unlocks the LUKS disk: nothing in
  the initramfs or crypttab knows about it.
- Lockout: wrong PINs also fail pam_unix, so pam_faillock counts them like wrong passwords. On top of that the PIN
  stops working after `pin_attempt_limit()` wrong tries (always lower than faillock's deny) until a password sign-in
  as root (the greeter, a polkit prompt) or a new PIN.
- Security keys: pam_u2f with /etc/worksuite/u2f_mappings (root-owned, 0644: key handles and public keys only).
- /var/lib/worksuite/signin/methods.json (0644) says which methods each user has, so the greeter (_greetd) and the
  shell can show the right choices. It holds no secrets.
"""
import base64
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import time

STATE_DIR = os.environ.get("WORKSUITE_SIGNIN_STATE", "/var/lib/worksuite/signin")
POLICY_FILE = os.environ.get("WORKSUITE_SIGNIN_POLICY", "/etc/worksuite/signin-policy.conf")
FAILLOCK_CONF = os.environ.get("WORKSUITE_FAILLOCK_CONF", "/etc/worksuite/faillock.conf")
U2F_MAPPINGS = os.environ.get("WORKSUITE_U2F_MAPPINGS", "/etc/worksuite/u2f_mappings")
RUN_DIR = os.environ.get("WORKSUITE_SIGNIN_RUN", "/run/worksuite-signin")

PIN_MAX_LENGTH = 12
PIN_MIN_DEFAULT = 6
PIN_MIN_FLOOR = 4
# scrypt: 32 MiB per check (~0.1 s), so an offline guess costs the same as an online one.
SCRYPT = {"n": 1 << 15, "r": 8, "p": 1}
MAXMEM = 64 * 1024 * 1024
PIN_USED_WINDOW_S = 60
METHODS = ("password", "pin", "key")


class SigninError(Exception):
    """A refusal with a stable code for the UI (never includes the PIN)."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ---- policy ----

def _conf(path):
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if "=" in line:
                    k, _, v = line.partition("=")
                    out[k.strip().lower()] = v.strip()
    except OSError:
        pass
    return out


def policy(path=None, faillock=None):
    """{allow_pin, pin_min_length, attempt_limit}. Written by worksuite-device-agent from the signed policy."""
    c = _conf(path or POLICY_FILE)
    allow = c.get("allow_pin", "1") not in ("0", "false", "no")
    try:
        mn = int(c.get("pin_min_length", PIN_MIN_DEFAULT))
    except ValueError:
        mn = PIN_MIN_DEFAULT
    mn = max(PIN_MIN_FLOOR, min(PIN_MAX_LENGTH, mn))
    return {"allow_pin": allow, "pin_min_length": mn, "attempt_limit": pin_attempt_limit(faillock)}


def pin_attempt_limit(faillock=None):
    """Wrong PINs before the password is required: two fewer than pam_faillock's deny (so the password still has
    tries left), at most 5, at least 1."""
    c = _conf(faillock or FAILLOCK_CONF)
    try:
        deny = int(c.get("deny", "5"))
    except ValueError:
        deny = 5
    if deny <= 0:  # faillock deny=0 means no lockout
        return 5
    return max(1, min(5, deny - 2))


# ---- PIN rules ----

def weak(pin):
    """Repeats (111111) and runs (123456, 654321) are refused, as on the AuthPin board."""
    if re.fullmatch(r"(\d)\1+", pin):
        return True
    return pin in "01234567890123456789" or pin in "98765432109876543210"


def check_new_pin(pin, pol):
    if not pol["allow_pin"]:
        raise SigninError("pin_disabled")
    if not isinstance(pin, str) or not re.fullmatch(r"\d+", pin):
        raise SigninError("digits_only")
    if len(pin) < pol["pin_min_length"]:
        raise SigninError("too_short")
    if len(pin) > PIN_MAX_LENGTH:
        raise SigninError("too_long")
    if weak(pin):
        raise SigninError("too_simple")


def pin_shaped(pin, pol):
    """Only PIN-shaped input is checked as a PIN; a password typed in the same field skips the PIN (no count)."""
    return isinstance(pin, str) and PIN_MIN_FLOOR <= len(pin) <= PIN_MAX_LENGTH and pin.isdigit() and pin.isascii()


# ---- verifier ----

def make_verifier(pin, salt=None, params=None):
    p = dict(params or SCRYPT)
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pin.encode("ascii"), salt=salt, n=p["n"], r=p["r"], p=p["p"], maxmem=MAXMEM, dklen=32)
    return {"v": 1, "kdf": "scrypt", "n": p["n"], "r": p["r"], "p": p["p"],
            "salt": base64.b64encode(salt).decode(), "hash": base64.b64encode(h).decode(), "failures": 0,
            "set_at": int(time.time() * 1000)}


def matches(rec, pin):
    if rec.get("kdf") != "scrypt":
        return False
    try:
        salt = base64.b64decode(rec["salt"])
        want = base64.b64decode(rec["hash"])
        got = hashlib.scrypt(pin.encode("ascii"), salt=salt, n=int(rec["n"]), r=int(rec["r"]), p=int(rec["p"]),
                             maxmem=MAXMEM, dklen=len(want))
    except (KeyError, ValueError, TypeError, UnicodeEncodeError):
        return False
    return hmac.compare_digest(got, want)


def _pin_dir(state=None):
    return os.path.join(state or STATE_DIR, "pin")


def pin_path(uid, state=None):
    return os.path.join(_pin_dir(state), f"{int(uid)}.json")


def _ensure_dirs(state=None):
    st = state or STATE_DIR
    os.makedirs(st, mode=0o755, exist_ok=True)
    os.makedirs(_pin_dir(st), mode=0o700, exist_ok=True)
    os.chmod(_pin_dir(st), 0o700)


def _write_private(path, data):
    tmp = f"{path}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_pin(uid, state=None):
    try:
        with open(pin_path(uid, state), encoding="utf-8") as f:
            rec = json.load(f)
        return rec if isinstance(rec, dict) else None
    except (OSError, ValueError):
        return None


class _Locked:
    """Exclusive lock per user so two checks can't both read the same failure count."""

    def __init__(self, uid, state=None):
        _ensure_dirs(state)
        self.path = pin_path(uid, state) + ".lock"

    def __enter__(self):
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


def set_pin(uid, pin, pol, state=None):
    check_new_pin(pin, pol)
    with _Locked(uid, state):
        _write_private(pin_path(uid, state), make_verifier(pin))


def remove_pin(uid, state=None):
    with _Locked(uid, state):
        try:
            os.unlink(pin_path(uid, state))
        except FileNotFoundError:
            return False
    return True


def verify_pin(uid, pin, pol, state=None, run=None):
    """'ok' | 'wrong' | 'locked' | 'no_pin' | 'disabled' | 'not_pin'. Counts only real PIN tries."""
    if not pol["allow_pin"]:
        return "disabled"
    if not pin_shaped(pin, pol):
        return "not_pin"
    with _Locked(uid, state):
        rec = read_pin(uid, state)
        if not rec:
            return "no_pin"
        if int(rec.get("failures", 0)) >= pol["attempt_limit"]:
            return "locked"
        if matches(rec, pin):
            if rec.get("failures"):
                rec["failures"] = 0
                _write_private(pin_path(uid, state), rec)
            _mark_pin_used(uid, run)
            return "ok"
        rec["failures"] = int(rec.get("failures", 0)) + 1
        _write_private(pin_path(uid, state), rec)
        return "locked" if rec["failures"] >= pol["attempt_limit"] else "wrong"


def reset_failures(uid, state=None):
    with _Locked(uid, state):
        rec = read_pin(uid, state)
        if rec and rec.get("failures"):
            rec["failures"] = 0
            _write_private(pin_path(uid, state), rec)


def tries_left(uid, pol, state=None):
    rec = read_pin(uid, state)
    if not rec:
        return None
    return max(0, pol["attempt_limit"] - int(rec.get("failures", 0)))


# ---- "this sign-in used the PIN" (so pam_gnome_keyring is not handed the PIN as the keyring password) ----

def _used_path(uid, run=None):
    return os.path.join(run or RUN_DIR, f"pin-used-{int(uid)}")


def _mark_pin_used(uid, run=None):
    d = run or RUN_DIR
    os.makedirs(d, mode=0o700, exist_ok=True)
    fd = os.open(_used_path(uid, d), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.close(fd)


def consume_pin_used(uid, run=None, now=None):
    p = _used_path(uid, run)
    try:
        age = (now or time.time()) - os.stat(p).st_mtime
        os.unlink(p)
    except FileNotFoundError:
        return False
    return age <= PIN_USED_WINDOW_S


# ---- methods.json (public index) ----

def methods_path(state=None):
    return os.path.join(state or STATE_DIR, "methods.json")


def read_methods(state=None):
    try:
        with open(methods_path(state), encoding="utf-8") as f:
            m = json.load(f)
        if isinstance(m, dict) and isinstance(m.get("users"), dict):
            return m
    except (OSError, ValueError):
        pass
    return {"v": 1, "users": {}}


def write_methods(m, state=None):
    _ensure_dirs(state)
    p = methods_path(state)
    tmp = f"{p}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(m, f, sort_keys=True)
    os.chmod(tmp, 0o644)
    os.replace(tmp, p)


def update_user(user, fn, state=None):
    m = read_methods(state)
    u = m["users"].get(user) or {"pin": False, "keys": [], "default": "password"}
    fn(u)
    if u["default"] == "pin" and not u["pin"] or u["default"] == "key" and not u["keys"]:
        u["default"] = "password"
    if not u["pin"] and not u["keys"] and u["default"] == "password":
        m["users"].pop(user, None)
    else:
        m["users"][user] = u
    write_methods(m, state)
    return m


def set_default(user, method, state=None):
    if method not in METHODS:
        raise SigninError("bad_method")
    u = read_methods(state)["users"].get(user) or {"pin": False, "keys": []}
    if method == "pin" and not u.get("pin") or method == "key" and not u.get("keys"):
        raise SigninError("not_set_up")
    update_user(user, lambda x: x.__setitem__("default", method), state)


def any_pin(state=None):
    return any(u.get("pin") for u in read_methods(state)["users"].values())


def any_key(state=None):
    return any(u.get("keys") for u in read_methods(state)["users"].values())


# ---- pam_u2f mappings: "user:KeyHandle,PublicKey,CoseType,Options:..." ----

_CRED = re.compile(r"^[A-Za-z0-9+/=_*-]+,[A-Za-z0-9+/=_-]+,[a-zA-Z0-9]+,[+a-zA-Z]*$")


def key_id(cred):
    return hashlib.sha256(cred.split(",", 1)[0].encode()).hexdigest()[:16]


def read_mappings(path=None):
    out = {}
    try:
        with open(path or U2F_MAPPINGS, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or ":" not in line:
                    continue
                user, _, rest = line.partition(":")
                out[user] = [c for c in rest.split(":") if c]
    except OSError:
        pass
    return out


def write_mappings(maps, path=None):
    p = path or U2F_MAPPINGS
    os.makedirs(os.path.dirname(p), mode=0o755, exist_ok=True)
    tmp = f"{p}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("# Written by worksuite-signin (Settings > Users > Security key). pam_u2f authfile.\n")
        for user in sorted(maps):
            if maps[user]:
                f.write(user + ":" + ":".join(maps[user]) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, p)


def parse_pamu2fcfg(out):
    """pamu2fcfg -n prints ':KeyHandle,PublicKey,CoseType,Options' (leading colon, no user)."""
    cred = out.strip().lstrip(":")
    if ":" in cred or not _CRED.match(cred):
        raise SigninError("key_failed")
    return cred


def add_key(user, cred, name, state=None, path=None, now=None):
    name = " ".join((name or "").split())[:60] or "Security key"
    maps = read_mappings(path)
    kid = key_id(cred)
    if any(key_id(c) == kid for c in maps.get(user, [])):
        raise SigninError("key_exists")
    maps.setdefault(user, []).append(cred)
    write_mappings(maps, path)
    added = int((now or time.time()) * 1000)
    update_user(user, lambda u: u["keys"].append({"id": kid, "name": name, "added": added}), state)
    return kid


def remove_key(user, kid, state=None, path=None):
    maps = read_mappings(path)
    before = maps.get(user, [])
    maps[user] = [c for c in before if key_id(c) != kid]
    if len(maps[user]) == len(before):
        # Not in the authfile; still drop a stale index entry.
        pass
    write_mappings(maps, path)
    update_user(user, lambda u: u.__setitem__("keys", [k for k in u["keys"] if k.get("id") != kid]), state)
