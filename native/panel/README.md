# Panel

There is no separate `worksuite-panel` binary or unit. The WorkSuite shell's taskbar is the panel
(SRS §5.1 allows a React panel once it consumes the bridge), so `worksuite-panel.service` was removed and
`worksuite-shell.service` wants `worksuite-wayland-bridge.service`.

- Window list, activate and minimize come only from `lk.worksuite.WaylandBridge1` (`../wayland-bridge/`),
  called from the shell's Electron main process (`shell/electron/panel.ts`), which the bridge verifies by its
  executable (WSOS-SHL-004). The panel never binds foreign-toplevel itself.
- Tray: StatusNotifierItems registered with the bridge's `org.kde.StatusNotifierWatcher`, listed and activated
  through `lk.worksuite.Tray1` (`shell/src/components/PanelItems.tsx`).
- Update badge (WSOS-AUP-011): available, installing, ready-to-restart and failed, from the package service's
  update coordinator.
- Super key: Labwc calls `lk.worksuite.Shell1.ToggleLauncher`, exported by the shell (`shell/dbus/lk.worksuite.Shell1.xml`).
- Keyboard: arrow keys move between taskbar and tray buttons; visible focus; high contrast, reduced motion and
  text size from the Accessibility panel (WSOS-ACC-001…006).

Still open: the shell is one fullscreen Electron window, not a `zwlr_layer_shell_v1` surface per output, so it
does not reserve a screen edge and has no per-monitor panel (WSOS-DSK-005/007). `OutputsChanged` and
`ListOutputs` are available for that work; a layer-shell Electron integration or a native panel would consume
the same bridge interface.
