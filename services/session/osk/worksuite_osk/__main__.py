"""worksuite-osk [--kiosk] [--size small|medium|large] [--mode full|split|floating] [--langs en,si,ta] [--no-suggestions]

Started by the shell (shell/electron/touch.ts) or the kiosk session (worksuite-kiosk-start, --kiosk: always shown).
"""
from __future__ import annotations

import argparse
import os

from .engine import MODES, Keyboard


def options(argv=None):
    p = argparse.ArgumentParser(prog="worksuite-osk")
    p.add_argument("--kiosk", action="store_true")
    p.add_argument("--size", choices=("small", "medium", "large"), default="medium")
    p.add_argument("--mode", choices=MODES, default="full")
    p.add_argument("--langs", default="en,si,ta")
    p.add_argument("--no-suggestions", action="store_true")
    o = p.parse_args(argv)
    o.langs = tuple(x for x in o.langs.split(",") if x in ("en", "si", "ta")) or ("en",)
    return o


def main(argv=None) -> int:  # pragma: no cover
    o = options(argv)
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    kb = Keyboard(lang=o.langs[0], langs=o.langs, mode=o.mode, suggestions_on=not o.no_suggestions,
                  learned_path=None if o.kiosk else os.path.join(data, "worksuite", "osk-words.json"))
    from .ui import run
    return run(kb, o.size, o.kiosk, os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "worksuite-osk.sock"))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
