# worksuite-session

Session file, launcher and systemd user units (SRS §4, WSOS-SES-001…006).

| File | Installed to |
|---|---|
| `wayland-sessions/worksuite.desktop` | `/usr/share/wayland-sessions/` (greetd default session) |
| `bin/worksuite-session` | `/usr/bin/` |
| `labwc/{rc.xml,autostart,environment}` | `/etc/xdg/worksuite/labwc/` |
| `portals/worksuite-portals.conf` | `/usr/share/xdg-desktop-portal/` |
| `systemd/user/*` | `/usr/lib/systemd/user/` |
| `bin/worksuite-{lock,idle,greeter,polkit-agent}` | `/usr/lib/worksuite/` |
| `gtklock/{config.ini,style.css}` | `/etc/xdg/worksuite/gtklock/` |
| `pam/worksuite-faillock*`, `pam/worksuite-offline-access` | `/usr/share/pam-configs/` (enabled by `pam-auth-update` in postinst) |
| `pam/faillock.conf` | `/usr/share/worksuite/`, copied to `/etc/worksuite/faillock.conf` when missing |
| `tmpfiles/worksuite-session.conf` | `/usr/lib/tmpfiles.d/` |
| `kiosk/worksuite-kiosk-{session,start,ctl,apply,signin,exit}` | `/usr/lib/worksuite/` (kiosk mode) |
| `kiosk/worksuite_kiosk.py` | `/usr/lib/worksuite/kiosk/` |
| `kiosk/polkit/lk.worksuite.kiosk.policy` | `/usr/share/polkit-1/actions/` |
| `pam/worksuite-kiosk-signin` | `/usr/share/pam-configs/` |

Flow: greeter → `worksuite-session` (clears stale env, runs Labwc) → Labwc `autostart` → `worksuite-session --ready`
imports `WAYLAND_DISPLAY`, `DISPLAY` (if XWayland), `XDG_CURRENT_DESKTOP=WorkSuite:wlroots` into systemd and the
D-Bus activation environment, then starts `worksuite-session.target` (shell, panel, bridge, background, sync).
When Labwc exits the launcher stops sync, locks the login keyring, stops the target and unsets display variables.

Shell crash: `Restart=always`, `RestartSec=1s` (≤ 3 s). Three failures within 60 s hit the start limit and
`OnFailure=` starts `worksuite-recovery-launcher.service`. The shell launches every app with
`systemd-run --user --scope --slice=app.slice --unit=app-worksuite-<id>-<n>.scope -- gtk-launch <id>`
(`shell/electron/session.ts`), so apps live outside the shell's cgroup and survive a shell crash (WSOS-REL-004).

Log out (shell): `systemd-run --user --unit=worksuite-logout -- worksuite-session --logout`, i.e. the same cleanup as a
compositor exit (stop sync, drop tokens, lock the keyring, stop the target, unset display variables), then Labwc ends.

Compositor exit with an error: `worksuite-session` drops `/run/worksuite/session-notice/uid-<uid>`; greetd runs
`worksuite-greeter`, which shows "Your last session ended unexpectedly…" (zenity) once, removes the notices and
starts gtkgreet (WSOS-SES-006).

Screen lock (WSOS-LOCK-001…004): `worksuite-idle.service` runs swayidle with `-w`:
`timeout <T> 'loginctl lock-session'`, `lock worksuite-lock`, `before-sleep worksuite-lock`. Super+L, the shell's
Lock button and the device agent's RequestLock all use `loginctl lock-session`. `worksuite-lock` starts gtklock
(ext-session-lock-v1) under a guard and returns only once gtklock reports the lock held, so logind's delay inhibitor
is released after the screen is locked. If gtklock dies the compositor keeps the outputs locked and the guard starts
a new gtklock; only a PAM-successful unlock (exit 0) ends it. T = the user's choice in Settings > Power
(`~/.config/worksuite/lock.conf`) capped by the policy maximum (`/etc/worksuite/lock-policy.conf`, device agent);
`worksuite-idle-policy.path` restarts swayidle when either changes.

Administrator prompts (WSOS-INT-010): `worksuite-polkit-agent.service` runs lxpolkit (or mate-polkit). Failed
sign-ins (WSOS-AUTH-004): pam_faillock in common-auth/common-account with `conf=/etc/worksuite/faillock.conf`
(deny 5 in 15 min → 10 min lockout by default; policy `login_failures_max` / `login_lockout_s`). Offline period
(WSOS-AUTH-003): pam_nologin refuses sign-in while `/etc/worksuite/offline-access-expired` exists (device agent).

Tests: `sh tests/session/session-test.sh` (stubbed gtklock, swayidle, systemctl, zenity, gtkgreet).

## Kiosk mode (WSOS-AUTH-002, SRS §2.3)

Set by the admin in the console (policy `kiosk`, per device). The device agent writes `/etc/worksuite/kiosk.json`,
`/etc/worksuite/kiosk/session.env`, the locked Labwc config `/etc/worksuite/kiosk/labwc/` and the 0600 exit-PIN
verifier, then runs `worksuite-kiosk-apply enable USER` through systemd-run: locked kiosk account, greetd autologin
(`worksuite-autologin --kiosk`), no gettys on other VTs, Ctrl+Alt+Del masked. At sign-in `worksuite-session` hands the
kiosk account to `worksuite-kiosk-session` (Labwc with only the exit binding, Ctrl+Alt+Shift+K; XKB `srvrkeys:none`;
app data wiped at start and end) → `worksuite-kiosk-start` (polkit agent, on-screen keyboard hook `worksuite-osk`,
swayidle idle reset, the kiosk app `shell/dist-electron/kiosk.cjs` restarted when it exits). Exit: Ctrl+Alt+Shift+K
or five taps top-left → exit prompt → `pkexec worksuite-kiosk-exit --pin` (PIN on stdin, verifier, 5 tries per
15 min) or `--admin` (polkit auth_admin) → the kiosk session ends and the greeter shows; `worksuite-kiosk-signin`
(PAM, greetd only) lets just the kiosk account and administrators sign in there. Tests: `tests/session/kiosk-test.sh`,
`python3 -m unittest discover -s services/session/kiosk -t services/session/kiosk`.
