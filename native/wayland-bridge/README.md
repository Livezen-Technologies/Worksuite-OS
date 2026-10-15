# worksuite-wayland-bridge

Native user service (`worksuite-wayland-bridge.service`, D-Bus `lk.worksuite.WaylandBridge1`) that observes
`wlr-foreign-toplevel-management-unstable-v1` / `ext-foreign-toplevel-list-v1` and `wl_output`/`xdg-output`
from Labwc and exposes restricted window operations to the shell and panel. Interface: `lk.worksuite.WaylandBridge1.xml`.

- WSOS-SHL-001: probe protocol versions at bind; `SupportedOperations` reflects them; anything else → `Error.NotSupported`.
- WSOS-SHL-002: `ActivateWindow` forwards the xdg-activation token; without a valid token Labwc's focus-stealing prevention applies.
- WSOS-SHL-003: handles are opaque random strings, never reused; unknown/closed handle → `Error.NotFound`, no crash.
- WSOS-SHL-004: caller verified via `GetConnectionCredentials` (UID = session UID and `/proc/<pid>/exe` is the
  installed shell or panel binary); otherwise `AccessDenied`.

Native code (C or Rust) is not yet in this repo. Arm64 and amd64 builds are required (WSOS-ARM-004).
