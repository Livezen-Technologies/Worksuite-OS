"""Caller verification (WSOS-SHL-004): same UID as the session, and the caller process is the installed
shell or panel binary. Credentials come from the bus daemon (GetConnectionCredentials), never from the caller."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Callable

DEFAULT_ALLOWED = (
    "/usr/lib/worksuite/shell/electron/electron",  # worksuite-shell (Electron main process)
)


def allowed_from_env() -> tuple[str, ...]:
    # Packaging and tests may extend the list; the variable is read from the unit's environment only.
    extra = os.environ.get("WORKSUITE_BRIDGE_ALLOWED_EXES", "")
    return DEFAULT_ALLOWED + tuple(p for p in extra.split(":") if p)


def _exe_of(pid: int) -> str | None:
    try:
        return os.path.realpath(os.readlink(f"/proc/{pid}/exe"))
    except OSError:
        return None


@dataclass
class AccessPolicy:
    uid: int = field(default_factory=os.getuid)
    allowed: tuple[str, ...] = field(default_factory=allowed_from_env)
    exe_of: Callable[[int], str | None] = _exe_of

    def permits(self, caller_uid: int | None, caller_pid: int | None) -> bool:
        if caller_uid is None or caller_pid is None or caller_uid != self.uid:
            return False
        exe = self.exe_of(caller_pid)
        if exe is None:
            return False
        return exe in {os.path.realpath(a) for a in self.allowed}
