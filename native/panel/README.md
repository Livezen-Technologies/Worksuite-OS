# worksuite-panel

Native layer-shell taskbar, one instance per output (SRS §5.1). Native by default; a React panel is allowed
only after a tested Electron/Chromium layer-shell integration passes the prototype decision gate.

- `zwlr_layer_shell_v1`, layer `top`, anchored bottom, exclusive zone reserves the edge; recreated on output hotplug
  (monitor unplug must not strand the launcher).
- Window list comes only from `lk.worksuite.WaylandBridge1` (`../wayland-bridge/`); the panel never binds
  foreign-toplevel itself.
- Hosts clock, StatusNotifierItem tray (WSOS-INT-008), quick settings (NetworkManager, PipeWire, BlueZ, UPower),
  update badge (WSOS-AUP-011) and sync state.
- Full keyboard operation, visible focus, Orca support via AT-SPI, 200 % text scale (WSOS-ACC-001…006).
- Runs as `worksuite-panel.service` (`services/session/systemd/user/`), `Restart=always`.

Native code is not yet in this repo. Arm64 and amd64 builds are required (WSOS-ARM-004).
