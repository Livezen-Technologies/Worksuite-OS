# worksuite-session

Session file, launcher and systemd user units (SRS §4, WSOS-SES-001…006).

| File | Installed to |
|---|---|
| `wayland-sessions/worksuite.desktop` | `/usr/share/wayland-sessions/` (greetd default session) |
| `bin/worksuite-session` | `/usr/bin/` |
| `labwc/{rc.xml,autostart,environment}` | `/etc/xdg/worksuite/labwc/` |
| `portals/worksuite-portals.conf` | `/usr/share/xdg-desktop-portal/` |
| `systemd/user/*` | `/usr/lib/systemd/user/` |

Flow: greeter → `worksuite-session` (clears stale env, runs Labwc) → Labwc `autostart` → `worksuite-session --ready`
imports `WAYLAND_DISPLAY`, `DISPLAY` (if XWayland), `XDG_CURRENT_DESKTOP=WorkSuite:wlroots` into systemd and the
D-Bus activation environment, then starts `worksuite-session.target` (shell, panel, bridge, background, sync).
When Labwc exits the launcher stops sync, locks the login keyring, stops the target and unsets display variables.

Shell crash: `Restart=always`, `RestartSec=1s` (≤ 3 s). Three failures within 60 s hit the start limit and
`OnFailure=` starts `worksuite-recovery-launcher.service`. The shell must launch apps with
`systemd-run --user --scope --unit=app-…` so they live outside the shell's cgroup.
