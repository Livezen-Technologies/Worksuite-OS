"""Low-resolution output captures for Task View's desktop cards (WSOS-DSK-003).

Labwc 0.8 (wlroots 0.18) offers wlr-screencopy-v1 for whole outputs only: per-window capture
(ext-image-copy-capture-v1 with ext-foreign-toplevel-image-capture-source-v1) came with wlroots 0.19 / Labwc 0.9, and
Labwc has no toplevel-export protocol. So Task View shows each window as a card with its app icon and title, and the
current desktop's card shows a capture of the whole output, taken on demand when Task View opens.

The capture is `grim` (wlr-screencopy) writing a small JPEG to its standard output: scaled down to at most
`max_width` pixels, kept in memory, never written to disk, returned to the shell (the only caller allowed, see
service.py) and dropped by the bridge right away.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from typing import Callable

from .model import NotFound, NotSupported, Output

MAX_BYTES = 2 * 1024 * 1024
SAFE_OUTPUT = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

Capture = Callable[[list[str]], bytes | None]


def _grim(argv: list[str]) -> bytes | None:
    try:
        r = subprocess.run(argv, check=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 and 0 < len(r.stdout) <= MAX_BYTES else None


class OutputCapture:
    def __init__(self, capture: Capture = _grim, which: Callable[[str], str | None] = shutil.which):
        self.capture, self.which = capture, which

    def available(self) -> bool:
        return self.which("grim") is not None

    @staticmethod
    def argv(output: Output, max_width: int) -> list[str]:
        width = max(1, output.width or 1920)
        scale = max(0.05, min(1.0, max(64, min(640, max_width)) / width))
        return ["grim", "-o", output.name, "-s", f"{scale:.3f}", "-t", "jpeg", "-q", "60", "-"]

    def grab(self, outputs: list[Output], name: str, max_width: int) -> bytes:
        if not self.available():
            raise NotSupported("output capture needs grim (wlr-screencopy)")
        out = next((o for o in outputs if o.name == name), None) if name else (outputs[0] if outputs else None)
        if out is None or not SAFE_OUTPUT.match(out.name):
            raise NotFound(f"no output {name!r}")
        data = self.capture(self.argv(out, max_width))
        if not data:
            raise NotSupported("the compositor did not provide a capture")
        return data
