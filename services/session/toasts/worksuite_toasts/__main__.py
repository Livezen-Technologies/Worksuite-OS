"""worksuite-toasts: started by the shell (shell/electron/toastHost.ts) with a pipe on stdin/stdout."""
from .ui import run

if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(run())
