"""Control socket ($XDG_RUNTIME_DIR/worksuite-osk.sock, 0600): the shell shows or hides the keyboard and passes the
focused field's type, as text-input-v3 content purpose and hint numbers (shell/src/lib/touch.ts contentHintFor).

  show <purpose> <hints>   |   hide   |   toggle
"""
from __future__ import annotations

import re

LINE = re.compile(r"^(show) (\d{1,2}) (\d{1,5})$|^(hide|toggle)$")


def parse(line: str) -> tuple[str, int, int] | None:
    m = LINE.match(line.strip())
    if not m:
        return None
    if m.group(1):
        purpose, hints = int(m.group(2)), int(m.group(3))
        return ("show", purpose if purpose <= 13 else 0, hints & 0x3FF)
    return (m.group(4), 0, 0)
