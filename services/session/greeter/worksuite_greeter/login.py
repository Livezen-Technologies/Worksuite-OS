"""Sign-in logic of the WorkSuite greeter, kept free of GTK so it is unit tested.

- WSOS-AUTH-001: authenticates through greetd (PAM) and starts the WorkSuite session by default.
- WSOS-DIR-002: "Other user" accepts user, user@domain and DOMAIN\\user; the directory domain is shown.
- WSOS-DIR-007: an expired password is changed here (the PAM helper receives a framed old/new pair).
- WSOS-DIR-009: accounts with a second factor type a verification code, sent after the password.
"""
import hashlib
import json
import os
import pwd
import re

RUN_DIR = os.environ.get("WORKSUITE_DIRECTORY_RUN", "/run/worksuite-directory")
DEFAULT_SESSION = ["/usr/bin/worksuite-session"]
# Must match CHANGE_PREFIX in services/directory/src/directory.ts.
CHANGE_PREFIX = "\x1bWSCHG\x1f"
SEP = "\x1f"
DIRECTORY_UID_MIN = 200_000

_LOCAL = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
_EMAIL = re.compile(r"^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,63}$")


def load_config(run_dir=RUN_DIR):
    """Directory settings for the greeter: {domain, netbios_domain, upn_suffixes}; {} when not joined."""
    try:
        with open(os.path.join(run_dir, "greeter.json"), encoding="utf-8") as f:
            c = json.load(f)
        return c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        return {}


def suffixes(cfg):
    out = []
    for s in [cfg.get("domain")] + list(cfg.get("upn_suffixes") or []):
        if isinstance(s, str) and s and s.lower() not in out:
            out.append(s.lower())
    return out


def domain_label(cfg):
    """Text shown under "Other user", or None when the device is not joined to a directory."""
    sx = suffixes(cfg)
    if not sx:
        return None
    nb = cfg.get("netbios_domain")
    return f"{nb} ({sx[0]})" if nb else sx[0]


def local_exists(name, getpwnam=pwd.getpwnam):
    try:
        getpwnam(name)
        return True
    except KeyError:
        return False


class NameError_(ValueError):
    pass


def normalize(raw, cfg, suffix=None, getpwnam=pwd.getpwnam):
    """Canonical PAM user name for what was typed.

    user@domain  -> lower-cased, accepted for the directory domain or one of its UPN suffixes
    DOMAIN\\user  -> user@<domain> when DOMAIN is the directory's NetBIOS name
    user         -> a local account if one exists, else user@<chosen suffix or domain>
    """
    s = (raw or "").strip()
    if not s:
        raise NameError_("empty")
    sx = suffixes(cfg)
    if "\\" in s:
        dom, _, user = s.partition("\\")
        nb = (cfg.get("netbios_domain") or "").upper()
        if not nb or dom.upper() != nb or not sx:
            raise NameError_("unknown_domain")
        name = f"{user.lower()}@{sx[0]}"
    elif "@" in s:
        name = s.lower()
        if sx and name.rsplit("@", 1)[1] not in sx and not local_exists(name, getpwnam):
            raise NameError_("unknown_domain")
    else:
        low = s.lower()
        if local_exists(s, getpwnam):
            return s
        if not sx:
            if not _LOCAL.match(low):
                raise NameError_("invalid")
            return s
        chosen = (suffix or sx[0]).lower()
        if chosen not in sx:
            raise NameError_("unknown_domain")
        name = f"{low}@{chosen}"
    if not _EMAIL.match(name):
        raise NameError_("invalid")
    return name


def name_status(name, run_dir=RUN_DIR):
    """'expired' / 'mfa' set by the directory PAM helper after a failed sign-in, else None."""
    key = hashlib.sha256(name.encode("utf-8")).hexdigest()
    try:
        with open(os.path.join(run_dir, "greeter", key), encoding="utf-8") as f:
            s = f.read(16).strip()
        return s if s in ("expired", "mfa") else None
    except OSError:
        return None


def users(getpwall=pwd.getpwall, min_uid=1000):
    """Real accounts for the user tiles: people (uid >= 1000) with a login shell, plus directory accounts."""
    out = []
    for p in getpwall():
        if p.pw_uid < min_uid or p.pw_uid == 65534 or p.pw_name == "wsadmin":
            continue
        if p.pw_shell.endswith(("nologin", "false")):
            continue
        out.append({"name": p.pw_name, "display": (p.pw_gecos.split(",")[0] or p.pw_name), "directory": p.pw_uid >= DIRECTORY_UID_MIN})
    return sorted(out, key=lambda u: u["display"].lower())


def secret_for(password, otp=None, new_password=None):
    if new_password is not None:
        return CHANGE_PREFIX + password + SEP + new_password
    return password + (otp or "")


class Result:
    def __init__(self, ok, reason=None, messages=()):
        self.ok, self.reason, self.messages = ok, reason, list(messages)

    def __repr__(self):
        return f"Result({self.ok!r}, {self.reason!r}, {self.messages!r})"


def sign_in(greetd, name, password, otp=None, new_password=None, cmd=None, run_dir=RUN_DIR):
    """Runs one PAM conversation through greetd and starts the session on success.

    reason on failure: 'expired' (ask for a new password), 'mfa' (ask for a code), 'denied', 'error'.
    """
    if otp is not None and not re.fullmatch(r"\d{6}", otp):
        return Result(False, "bad_code")
    secret = secret_for(password, otp, new_password)
    messages = []
    try:
        r = greetd.create_session(name)
        answered = False
        while r.get("type") == "auth_message":
            kind = r.get("auth_message_type")
            if kind == "secret":
                if answered:
                    # A second secret prompt (e.g. a PAM module we do not drive): stop instead of re-sending.
                    greetd.cancel_session()
                    return Result(False, "denied", messages)
                r = greetd.respond(secret)
                answered = True
            elif kind == "visible":
                r = greetd.respond(name)
            else:
                if r.get("auth_message"):
                    messages.append(r["auth_message"])
                r = greetd.respond(None)
        if r.get("type") == "success":
            s = greetd.start_session(cmd or DEFAULT_SESSION)
            if s.get("type") == "success":
                return Result(True, None, messages)
            return Result(False, "error", messages + [s.get("description", "")])
        greetd.cancel_session()
        status = name_status(name, run_dir)
        if status:
            return Result(False, status, messages)
        return Result(False, "denied" if r.get("error_type") == "auth_error" else "error", messages)
    finally:
        secret = None  # noqa: F841  (drop the reference; Python strings cannot be wiped)
