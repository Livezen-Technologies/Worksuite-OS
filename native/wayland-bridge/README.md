# worksuite-wayland-bridge

User service (`worksuite-wayland-bridge.service`, `Type=dbus`, name `lk.worksuite.WaylandBridge1`) that binds
`zwlr_foreign_toplevel_manager_v1` and `wl_output` on Labwc and exposes restricted window operations to the
WorkSuite shell's panel. Python 3 with `python3-pywayland` and `python3-dbus-next` (both in Debian trixie);
architecture-independent, so the same package serves amd64 and arm64 (WSOS-ARM-004).

| Path | |
|---|---|
| `lk.worksuite.WaylandBridge1.xml` | window list, activate, close, minimize, outputs, signals |
| `lk.worksuite.Tray1.xml` | tray items for the panel (the bridge is also `org.kde.StatusNotifierWatcher` and the host) |
| `protocols/` | vendored `wlr-foreign-toplevel-management-unstable-v1.xml` |
| `worksuite_bridge/` | `model.py` handles/flags/errors, `access.py` caller check, `service.py` D-Bus, `wayland.py` Labwc |
| `bin/worksuite-wayland-bridge` | entry point, installed to `/usr/libexec/worksuite/` |
| `tests/` | unit, D-Bus contract (private bus), headless Labwc + foot, and the shell's panel client against the bridge |

`make protocols` generates the pywayland bindings into `worksuite_bridge/protocol/` (needs `wayland.xml` from
`libwayland-dev`); `make test` runs everything (the Labwc and Node tests skip when those tools are missing).

- WSOS-SHL-001: `SupportedOperations` lists what the bound protocol offers; anything else → `Error.NotSupported`
  (no `zwlr_foreign_toplevel_manager_v1` → nothing is supported, every call fails cleanly).
- WSOS-SHL-002: `ActivateWindow` takes an xdg-activation token, but wlr-foreign-toplevel cannot carry it: Labwc
  treats the request as coming from the panel. Only verified shell callers get this far.
- WSOS-SHL-003: handles are random (`w` + 16 hex digits) and never reused; unknown/closed → `Error.NotFound`.
- WSOS-SHL-004: the caller's UID and PID come from `GetConnectionCredentials`; the UID must be the session's and
  `/proc/<pid>/exe` the installed shell (`/usr/lib/worksuite/shell/electron/electron`); otherwise `AccessDenied`.
  Window signals are unicast to subscribed, verified callers only. `WORKSUITE_BRIDGE_ALLOWED_EXES` (unit
  environment) adds binaries, e.g. a future native panel.
- `ListWindows` returns `a(ssssu)` — handle, app_id, title, output, flags (activated 1, minimized 2, maximized 4,
  fullscreen 8). The earlier draft declared `a(sssu)`, one field short of the documented five.
