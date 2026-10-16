"""Kiosk exit (WSOS-AUTH-002): exit-PIN verification and ending the kiosk session.

The exit PIN is stored only as a verifier, ``scrypt$N$r$p$salt$hash`` (base64), made by the server
(services/server/src/kiosk.ts) and written 0600 root by the device agent. Verification is constant time and rate
limited: after MAX_FAILURES wrong PINs within WINDOW_S seconds every attempt is refused until the window passes.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time

VERIFIER = re.compile(r"^scrypt\$(16384|32768|65536)\$8\$1\$([A-Za-z0-9+/]{22,24}={0,2})\$([A-Za-z0-9+/]{43}=)$")
MAX_FAILURES = 5
WINDOW_S = 15 * 60


def parse_verifier(text):
    m = VERIFIER.match((text or "").strip())
    if not m:
        return None
    return int(m.group(1)), base64.b64decode(m.group(2)), base64.b64decode(m.group(3))


def verify_pin(pin, verifier):
    """True when pin matches the verifier. Malformed verifier or PIN → False (never raises)."""
    v = parse_verifier(verifier)
    if v is None or not isinstance(pin, str) or not re.fullmatch(r"\d{6,12}", pin):
        return False
    n, salt, want = v
    got = hashlib.scrypt(pin.encode(), salt=salt, n=n, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
    return hmac.compare_digest(got, want)


class Throttle:
    """Failed-attempt record in a root-owned file; survives restarts of the kiosk app."""

    def __init__(self, path, now=time.time):
        self.path, self.now = path, now

    def _load(self):
        try:
            with open(self.path) as f:
                return [t for t in json.load(f) if isinstance(t, (int, float)) and t > self.now() - WINDOW_S]
        except (OSError, ValueError, TypeError):
            return []

    def locked(self):
        return len(self._load()) >= MAX_FAILURES

    def fail(self):
        recent = self._load() + [self.now()]
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        tmp = self.path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(recent, f)
        os.replace(tmp, self.path)

    def clear(self):
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass


def read_env(path):
    """KIOSK_* values from the agent-written session.env (only expected shapes)."""
    out = {}
    try:
        with open(path) as f:
            for line in f:
                m = re.fullmatch(r"(KIOSK_USER)=([a-z_][a-z0-9_.@-]{0,63})|(KIOSK_[A-Z_]+)=(\d{1,6})", line.strip())
                if m:
                    out[m.group(1) or m.group(3)] = m.group(2) or m.group(4)
    except OSError:
        pass
    return out
