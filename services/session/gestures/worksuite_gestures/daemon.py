"""worksuite-gestures: reads the touchscreen's multitouch events (python3-evdev) and runs the configured actions.

Started by the shell (shell/electron/touch.ts) when a touchscreen is present and gestures are on; it reads
~/.config/worksuite/gestures.json, written by the shell, again on SIGHUP. The device is opened read-only and never
grabbed, so Labwc still gets every touch. udev gives the seat user read access to touchscreens only
(services/session/udev/70-worksuite-touch.rules). Touch positions are never logged.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time

from .recognizer import Recognizer, command, normalize, plan


def load(path: str) -> dict:
    try:
        with open(path) as f:
            return normalize(json.load(f))
    except (OSError, ValueError):
        return normalize({})


def find_touchscreen(evdev):
    for p in evdev.list_devices():
        try:
            d = evdev.InputDevice(p)
        except OSError:
            continue
        caps = d.capabilities()
        abs_codes = [c[0] if isinstance(c, tuple) else c for c in caps.get(evdev.ecodes.EV_ABS, [])]
        if evdev.ecodes.ABS_MT_SLOT in abs_codes and evdev.ecodes.ABS_MT_POSITION_X in abs_codes and evdev.ecodes.BTN_TOUCH in caps.get(evdev.ecodes.EV_KEY, []):
            return d
        d.close()
    return None


def run(cfg_path: str) -> int:  # pragma: no cover - needs a touchscreen
    import evdev
    from evdev import ecodes as e
    cfg = {"v": load(cfg_path)}
    signal.signal(signal.SIGHUP, lambda *_: cfg.update(v=load(cfg_path)))
    dev = find_touchscreen(evdev)
    if dev is None:
        print("worksuite-gestures: no multitouch touchscreen", file=sys.stderr)
        return 0
    ax, ay = dev.absinfo(e.ABS_MT_POSITION_X), dev.absinfo(e.ABS_MT_POSITION_Y)
    nx = lambda v: (v - ax.min) / max(1, ax.max - ax.min)
    ny = lambda v: (v - ay.min) / max(1, ay.max - ay.min)
    r = Recognizer()
    slot, pending = 0, {}
    for ev in dev.read_loop():
        now = time.monotonic()
        if ev.type == e.EV_ABS:
            if ev.code == e.ABS_MT_SLOT:
                slot = ev.value
            elif ev.code == e.ABS_MT_TRACKING_ID:
                if ev.value < 0:
                    r.up(slot, now)
                    pending.pop(slot, None)
                else:
                    pending[slot] = [None, None]
            elif ev.code in (e.ABS_MT_POSITION_X, e.ABS_MT_POSITION_Y):
                p = pending.setdefault(slot, [None, None])
                p[0 if ev.code == e.ABS_MT_POSITION_X else 1] = nx(ev.value) if ev.code == e.ABS_MT_POSITION_X else ny(ev.value)
        elif ev.type == e.EV_SYN:
            for s, (x, y) in list(pending.items()):
                if x is None or y is None:
                    continue
                if s in r.contacts:
                    g = r.move(s, x, y, now)
                    if g:
                        p = plan(g, cfg["v"])
                        argv = command(*p) if p else None
                        if argv:
                            subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    r.down(s, x, y, now)
    return 0


def main() -> int:  # pragma: no cover
    home = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return run(os.path.join(home, "worksuite", "gestures.json"))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
