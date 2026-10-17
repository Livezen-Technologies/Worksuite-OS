# worksuite-wayland-bridge

User service (`worksuite-wayland-bridge.service`, `Type=dbus`, name `lk.worksuite.WaylandBridge1`) that binds
`zwlr_foreign_toplevel_manager_v1` and `wl_output` on Labwc and exposes restricted window operations to the
WorkSuite shell's panel. Python 3 with `python3-pywayland` and `python3-dbus-next` (both in Debian trixie);
architecture-independent, so the same package serves amd64 and arm64 (WSOS-ARM-004).

| Path | |
|---|---|
| `lk.worksuite.WaylandBridge1.xml` | window list, activate, close, minimize, outputs, signals |
| `lk.worksuite.Tray1.xml` | tray items for the panel (the bridge is also `org.kde.StatusNotifierWatcher` and the host) |
| `protocols/` | vendored `wlr-foreign-toplevel-management-unstable-v1.xml`, `wlr-layer-shell-unstable-v1.xml` (v4) and `xdg-shell.xml` (test client) |
| `worksuite_bridge/` | `model.py` handles/flags/errors, `access.py` caller check, `service.py` D-Bus, `wayland.py` Labwc, `layer.py` panel edge reservation |
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
- WSOS-DSK-005/007: for every output the bridge maps a transparent, input-less `zwlr_layer_surface_v1` on the
  bottom layer, anchored to the bottom edge with an exclusive zone of `WORKSUITE_PANEL_HEIGHT` logical pixels
  (default 56, the taskbar's height; 0 disables). Labwc then keeps maximised windows above the taskbar on each
  monitor, at any scale. Hot-plugged outputs get a reservation, unplugged ones drop theirs; Labwc moves windows
  off a removed output and the bridge relists them on their new output, then emits `OutputsChanged`. Chosen
  over rc.xml `<margin>`, which is static and cannot follow hotplug. The headless Labwc test runs two outputs
  (`WLR_HEADLESS_OUTPUTS=2`), checks each usable area with a probe layer surface, rescales and unplugs one with
  `wlr-randr`, and places a fullscreen window per output with `xdg_toplevel.set_fullscreen(output)` (what
  Chromium sends for the shell's per-monitor windows).
- `ListWindows` returns `a(ssssu)` — handle, app_id, title, output, flags (activated 1, minimized 2, maximized 4,
  fullscreen 8). The earlier draft declared `a(sssu)`, one field short of the documented five.
- WSOS-DSK-003 workspaces: Debian trixie's Labwc (0.8.x) has no client workspace protocol (ext-workspace-v1 arrived in
  Labwc 0.9.0), so the bridge uses Labwc's desktops (`worksuite_bridge/workspace.py`). `ListWorkspaces`,
  `ActivateWorkspace`, `MoveWindowToWorkspace` and `WorkspacesChanged`; "workspaces" in `SupportedOperations` when
  there is more than one desktop and `wtype` (virtual-keyboard) is installed. The panel's requests are sent as
  bridge-only Labwc bindings (Ctrl+Alt+Super+F<n>, with Shift to move the focused window); every desktop binding in
  rc.xml also runs `worksuite-workspace-event`, which reports to `lk.worksuite.WorkspaceEvents1` at
  `/lk/worksuite/WaylandBridge1/Workspaces` (callers of the session's UID only). Labwc does not say which desktop a
  window is on: the bridge places new windows on the current desktop and follows moves and focus. A backend on
  ext-workspace-v1 can replace this when the distribution ships Labwc ≥ 0.9, with the same D-Bus API.
