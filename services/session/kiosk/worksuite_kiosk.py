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


# ---- nightly screen-off (policy kiosk.screen_off; board KioskStates "Screen off until 07:00") ----------------------
def hhmm(text):
    """'2200' or '22:00' → minutes after midnight, or None."""
    m = re.fullmatch(r"([01]\d|2[0-3]):?([0-5]\d)", (text or "").strip())
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def screen_off_now(minute, start, end):
    """True when minute-of-day lies in [start, end); the window may span midnight (22:00–07:00)."""
    if start is None or end is None or start == end:
        return False
    return start <= minute < end if start < end else minute >= start or minute < end


def seconds_to_change(now, start, end):
    """Seconds from the datetime `now` until the window next opens or closes (at least 1)."""
    minute = now.hour * 60 + now.minute
    target = end if screen_off_now(minute, start, end) else start
    delta = (target - minute) % (24 * 60) or 24 * 60
    return max(1, delta * 60 - now.second)


class ScreenSchedule:
    """Turns the kiosk's outputs off for the night window and back on in the morning.

    In the window: outputs off (wlr-output-power-management via wlopm), and swayidle turns them back on at a touch or key
    for one minute (WAKE_S), showing "Screen off until HH:MM" (worksuite-kiosk-ctl screen-off), then off again. The
    commands are fixed argument lists; `run` and `spawn` are injectable for tests.
    """

    WAKE_S = 60

    def __init__(self, start, end, lib="/usr/lib/worksuite", run=None, spawn=None):
        import subprocess
        self.start, self.end, self.lib = start, end, lib
        self.run = run or (lambda argv: subprocess.run(argv, check=False))
        self.spawn = spawn or (lambda argv: subprocess.Popen(argv))
        self.idle = None
        self.off = None

    def until_text(self):
        return "%02d:%02d" % divmod(self.end, 60)

    def apply(self, minute):
        want = screen_off_now(minute, self.start, self.end)
        if want == self.off:
            return
        self.off = want
        ctl = os.path.join(self.lib, "worksuite-kiosk-ctl")
        if want:
            self.run([ctl, "screen-off", self.until_text()])
            self.run(["wlopm", "--off", "*"])
            self.idle = self.spawn(["swayidle", "-w", "timeout", str(self.WAKE_S), "wlopm --off '*'",
                                    "resume", "wlopm --on '*'"])
        else:
            if self.idle is not None:
                self.idle.terminate()
                self.idle = None
            self.run(["wlopm", "--on", "*"])
            self.run([ctl, "screen-on"])

    def loop(self, now=None, sleep=time.sleep):  # pragma: no cover - runs for the whole session
        import datetime
        now = now or datetime.datetime.now
        while True:
            t = now()
            self.apply(t.hour * 60 + t.minute)
            sleep(seconds_to_change(t, self.start, self.end))


def main(argv=None):  # pragma: no cover - entry point
    import sys
    args = sys.argv[1:] if argv is None else argv
    if len(args) == 3 and args[0] == "screen-schedule":
        start, end = hhmm(args[1]), hhmm(args[2])
        if start is None or end is None or start == end:
            print("worksuite-kiosk-screen: bad window", file=sys.stderr)
            return 2
        ScreenSchedule(start, end, lib=os.environ.get("WORKSUITE_LIB", "/usr/lib/worksuite")).loop()
    print("usage: worksuite_kiosk.py screen-schedule HHMM HHMM", file=sys.stderr)
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
