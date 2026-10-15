# SRS gap analysis: WorkSuite OS

Source: *WorkSuite OS — Software Requirements Specification* (1.0 draft), checked against this repository on 2026-10-15.
Scoring: Done = 1 (implemented **and** covered by an automated test or CI run), Partial = 0.5, Missing = 0.
Config without a test, UI mock-ups with static data, and contract-only items count as Partial at most. `docs/requirements-traceability.md` was used as a starting point; every row was re-checked in code.
WSOS-ACC-001…006 appear in the SRS only as a range, so they are scored as one row.

## Summary

| Section | Items | Done | Partial | Missing | Score |
|---|---|---|---|---|---|
| 3 Architecture | 4 | 0 | 4 | 0 | 50% |
| 4 Boot, login, session, lock | 17 | 10 | 6 | 1 | 76% |
| 5 Shell | 18 | 1 | 8 | 9 | 28% |
| 6 Applications | 20 | 6 | 7 | 7 | 48% |
| 7 Integration and Drive | 19 | 3 | 15 | 1 | 55% |
| 8 Identity and sync | 18 | 12 | 6 | 0 | 83% |
| 9 Updates, MDM, installer | 22 | 11 | 11 | 0 | 75% |
| 11 Non-functional | 25 | 2 | 16 | 7 | 40% |
| 14 Additions (AUP, ARM, WIPE, DIR) | 40 | 15 | 10 | 15 | 50% |
| Unnumbered requirements (no WSOS ID) | 15 | 3 | 7 | 5 | 43% |
| **Overall** | **198** | | | | **54.5%** |

## 3 Architecture

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| WSOS-ARC-001 | Electron main runs as user, not a root command runner | Partial | `shell/electron/main.ts` uses fixed execFile arrays and sender-checked IPC; privileged ops go to package-service D-Bus. No test of the renderer→system boundary (§13.1 Security layer). |
| WSOS-ARC-002 | Privileged ops are named D-Bus methods behind polkit | Partial | `services/package-service/src/dbus.ts` + `polkit/lk.worksuite.package.policy`, tested in `services/package-service/test/dbus.test.ts`. Device agent D-Bus (`services/device-agent/dbus/*.xml`, `polkit/`) has no dispatch tests; the Wayland bridge does not exist. |
| WSOS-ARC-003 | Native apps stay independent compositor windows | Partial | Apps launched with `gtk-launch` (`shell/electron/main.ts`), Labwc owns windows (`services/session/labwc/rc.xml`). No embedding, but no test. |
| WSOS-ARC-004 | Desktop usable with all remote services unreachable | Partial | Shell bundled locally, sync offline-first (`services/sync/src/service.ts`). No offline E2E test; panel/bridge not built. |

## 4 Boot, login, session, lock

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| WSOS-BOOT-001 | UEFI boot | Done | `live-build/auto/config` (`--bootloaders grub-efi`); UEFI QEMU boot test `tests/vm/boot-test.sh` runs in `.github/workflows/image.yml`. Certified hardware not covered. |
| WSOS-BOOT-002 | LUKS2 passphrase in initramfs + recovery key | Partial | `installer/modules/partition.conf` (`luksGeneration: luks2`), `cryptsetup-initramfs` in package list, recovery key `installer/modules/worksuiterecovery/main.py` (unit tested). Encrypted install/boot never run end to end. |
| WSOS-BOOT-003 | Previous kernel kept selectable | Missing | No GRUB/kernel retention config found (no `grub.d` submenu or apt autoremove kernel settings). |
| WSOS-AUTH-001 | greetd + PAM greeter, WorkSuite default session | Partial | `live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot` (gtkgreet under cage), `services/session/wayland-sessions/worksuite.desktop`. VM test only checks greetd is active, not a login. |
| WSOS-AUTH-002 | No autologin by default | Partial | greetd config has no `initial_session`; `installer/modules/usersq.conf`. No kiosk/personal opt-in mechanism; no test. |
| WSOS-AUTH-003 | Offline login for provisioned local users within policy period | Done | Policy `offline_access_days`: after N days without a check-in the device agent locks all sessions and writes `/etc/worksuite/offline-access-expired`, which pam_nologin (`services/session/pam/worksuite-offline-access`) uses to refuse sign-in until the next successful check-in (`services/device-agent/src/agent.ts` `offlineAccessCheck`, `src/enforce.ts`; tested in `test/agent.test.ts`, incl. restart and restore). Within the period local PAM accounts sign in offline. |
| WSOS-AUTH-004 | PAM faillock with policy thresholds | Done | pam_faillock profiles `services/session/pam/worksuite-faillock*` (pam-auth-update in `worksuite-session.postinst`; the live-build hook fails the build if common-auth lacks pam_faillock) with `conf=/etc/worksuite/faillock.conf`; thresholds from policy `login_failures_max` / `login_lockout_s` (schema in `api-contracts/openapi.yaml`, validated in `services/server/src/console.ts`, written by the device agent `src/enforce.ts`). Mapping tested in `services/device-agent/test/agent.test.ts`, validation in `services/server/test/console.test.ts`. PAM stack not exercised in a VM test. |
| WSOS-SES-001 | Import display env before portals | Partial | `services/session/bin/worksuite-session` (`--ready`), `services/session/labwc/autostart`. Not tested. |
| WSOS-SES-002 | User units bound to worksuite-session.target | Partial | `services/session/systemd/user/*` (PartOf=). Panel and bridge units point at binaries that do not exist. Not tested. |
| WSOS-SES-003 | Clean logout | Done | Shell Log out runs `systemd-run --user --unit=worksuite-logout -- worksuite-session --logout` (`shell/electron/session.ts` `logoutCommand`, outside the shell cgroup) → full `cleanup()`: stop sync, stop credentials, lock the keyring, stop the target, unset display variables, end Labwc. Tested: `shell/electron/session.test.ts`, `tests/session/session-test.sh` (order of stop sync → keyring lock, compositor ended). No REL-001 cycle test. |
| WSOS-SES-004 | Shell restart ≤3 s without killing app windows | Done | `worksuite-shell.service` Restart=always RestartSec=1s, `KillMode=mixed`; apps are launched with `systemd-run --user --scope --slice=app.slice --unit=app-worksuite-<id>-<n>.scope -- gtk-launch <id>` (`shell/electron/session.ts` `appLaunchCommand`, tested in `session.test.ts`), so they are not in the shell cgroup. Unit wiring checked in `tests/session/session-test.sh`; no VM crash test. |
| WSOS-SES-005 | Recovery launcher after 3 crashes / 60 s | Partial | `StartLimitBurst=3`, `OnFailure=worksuite-recovery-launcher.service`; `shell/src/screens/Recovery.tsx`. Not tested. |
| WSOS-SES-006 | Labwc exit → greeter notice | Done | `worksuite-session` writes `/run/worksuite/session-notice/uid-<uid>` (tmpfiles: `_greetd`-owned, mode 1733) on abnormal Labwc exit; greetd runs `services/session/bin/worksuite-greeter`, which shows "Your last session ended unexpectedly… open applications may have closed" (zenity), removes the notices, then starts gtkgreet. Tested in `tests/session/session-test.sh`. |
| WSOS-LOCK-001 | ext-session-lock locker, not Electron overlay | Done | gtklock (ext-session-lock-v1) via `services/session/bin/worksuite-lock`, started by swayidle for `lock` (Super+L, shell Lock and device-agent RequestLock all call `loginctl lock-session`), idle timeout and before-sleep (`worksuite-idle`, `worksuite-idle.service`). Theme `services/session/gtklock/style.css` from the Lock board. Script logic tested with a stub gtklock in `tests/session/session-test.sh`; real gtklock not run in CI. `shell/src/screens/Lock.tsx` is not used as the lock. |
| WSOS-LOCK-002 | Lock before suspend, locked on resume | Done | `swayidle -w … before-sleep worksuite-lock`: worksuite-lock returns only after gtklock reports the lock held (`-L` hook), so logind's delay inhibitor is released after locking; the lock persists through resume until PAM unlock. Tested with stubs in `tests/session/session-test.sh`; not on hardware (see REL-002). |
| WSOS-LOCK-003 | Idle lock timeout user-configurable within policy max | Done | Settings › Power "Lock screen after" (`shell/src/screens/Settings.tsx` `ScreenLockRow`, `shell/electron/session.ts`) offers only values within policy `lock_timeout_max_s`; the device agent writes `/etc/worksuite/lock-policy.conf`; `worksuite-idle` caps the user value (no "never" under a maximum); `worksuite-idle-policy.path` restarts swayidle on change. Tested in `shell/electron/session.test.ts`, `tests/session/session-test.sh`, `services/device-agent/test/agent.test.ts`. |
| WSOS-LOCK-004 | Locker crash fails closed | Done | ext-session-lock keeps outputs locked if gtklock dies; the `worksuite-lock` guard restarts gtklock until it exits 0 (PAM success), and `worksuite-idle.service` uses `KillMode=process` so a swayidle restart never kills the locker. Crash/restart tested with a stub gtklock in `tests/session/session-test.sh`; not tested against a real compositor. |

## 5 Shell

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| WSOS-SHL-001 | Bridge exposes only supported ops, NotSupported otherwise | Missing | Only `native/wayland-bridge/lk.worksuite.WaylandBridge1.xml` + README; no code. |
| WSOS-SHL-002 | xdg-activation and focus-stealing prevention | Missing | Bridge not implemented. |
| WSOS-SHL-003 | Stale handles → NotFound | Missing | Bridge not implemented. |
| WSOS-SHL-004 | Only shell/panel may call bridge | Missing | Bridge not implemented (no D-Bus policy file either). |
| WSOS-DSK-001 | Launcher lists WorkSuite + installed Linux apps, favourites/pins | Partial | Launcher UI in `shell/src/screens/Desktop.tsx` uses static app data; no desktop-entry scan and no `desktop/v1/apps` client (server route exists in `services/server/src/api.ts`). |
| WSOS-DSK-002 | Search apps/settings/files/records ≤300 ms | Partial | Launcher search UI over in-memory static lists (`Desktop.tsx`); no real file/record index, no timing test. |
| WSOS-DSK-003 | Panel: running windows, minimize/restore, workspaces | Partial | Mock taskbar/workspace buttons in `Desktop.tsx` (local state); native panel (`native/panel/README.md`) not written, no bridge. |
| WSOS-DSK-004 | Panel: clock, network, volume, battery, BT, notifications, power | Partial | Clock, notification centre and power menu exist (`Desktop.tsx`, `components/Power.tsx`, `lib/power.ts` tested); network/volume/battery/BT are not wired to NetworkManager/PipeWire/UPower/BlueZ. |
| WSOS-DSK-005 | Per-monitor panel/background, 100–200% scaling | Missing | Native panel not implemented; no multi-output handling. |
| WSOS-DSK-006 | Display settings persisted per monitor | Missing | Settings › Displays is static text (`shell/src/screens/Settings.tsx` `SimplePanel`). |
| WSOS-DSK-007 | Monitor disconnect moves windows/launcher | Missing | No implementation. |
| WSOS-DSK-008 | Clipboard history off by default, excludes passwords | Missing | No clipboard history. |
| WSOS-DSK-009 | Default apps / mimeapps.list editable in Settings | Missing | Files open via `shell.openPath` (XDG default); no Settings editor, no mimeapps.list handling. |
| WSOS-DSK-010 | worksuite:// links resolve via links/resolve | Partial | `worksuite:` allow-listed in `shell/electron/main.ts`; server route `desktop/v1/links/resolve` in `services/server/src/api.ts`; no client-side resolution or scheme handler. |
| WSOS-DSK-011 | Shortcuts: Super, Alt+Tab, workspaces, Super+L, screenshot | Partial | `services/session/labwc/rc.xml` has Super, Alt+Tab, Super+L; Super calls `lk.worksuite.Shell1` which the shell never exports; no workspace or screenshot bindings. |
| WSOS-DSK-012 | Shell assets packaged locally | Done | Vite bundle loaded with `loadFile` (`shell/electron/main.ts`), packaged by `packaging/debian/worksuite-shell.install`; built in CI (`.github/workflows/ci.yml`) and booted in the image test. |
| WSOS-DSK-013 | File dialogs, DnD, clipboard, printing, links behave as standard | Partial | Portal config (`services/session/portals/worksuite-portals.conf`); no portal acceptance tests. |
| WSOS-DSK-014 | Tailwind v4 tokens, light and dark themes | Partial | Tailwind tokens in `shell/src/index.css`; no dark theme switch verified. |

## 6 Applications

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| WSOS-APP-001 | App Center one catalog with source/category/installed/updates filters | Partial | Filters work in `shell/src/screens/AppCenter.tsx`, but the catalog is a hard-coded `APPS` array, not read from APT/Flatpak/WorkSuite catalog. |
| WSOS-APP-002 | Preview of dependency changes and disk space before confirm | Done | `services/package-service/src/service.ts` (`preview`), `shell/electron/packages.ts`; tests `services/package-service/test/service.test.ts`, `shell/electron/packages.test.ts`. |
| WSOS-APP-003 | Policy allowlist and approved repos; blocked items say why | Partial | Allowlist enforced in `service.ts` (tested); App Center "blocked" reasons come from hard-coded catalog data, not policy. |
| WSOS-APT-001 | Debian trixie + signed WorkSuite repo, Signed-By | Done | `live-build/config/includes.chroot/etc/apt/sources.list.d/*.sources`, validation in `services/package-service/src/apt.ts`; `tests/repo/apt-e2e.sh` (CI job `apt-repo`). |
| WSOS-APT-002 | Refuse testing/unstable sources | Done | `apt.ts` `BAD_SUITES`, `live-build/auto/config` guard; tested in `services/package-service/test/service.test.ts`. |
| WSOS-APT-003 | Critical set removal blocked | Done | `apt.ts` `CRITICAL`/`isCritical`, enforced in `service.ts`; tested. |
| WSOS-APT-004 | One package lock shared with updates | Done | Single job queue in `service.ts`, coordinator uses it (`coordinator.ts`); tested in `service.test.ts`/`coordinator.test.ts`. |
| WSOS-APT-005 | Local .deb installs: admin auth, publisher, policy | Missing | No local .deb install path in package service or shell. |
| WSOS-APT-006 | Interrupted dpkg detected, audited Repair action | Partial | `dpkg --audit` detection + `Repair` (`service.ts`), tested; detection runs at service start rather than a boot-time unit, and no shell UI surfaces Repair. |
| WSOS-FLP-001 | Curated remotes; adding a remote needs admin + policy | Partial | Approved remotes from policy (`service.ts` `remoteFor`); no add-remote operation exists (so nothing to guard); only first approved remote ever used. |
| WSOS-FLP-002 | Install dialogs highlight broad Flatpak permissions | Done | Metadata parsed from `flatpak remote-info` (`service.ts`), shown in `AppCenter.tsx` (`describePermission`); tested in `service.test.ts`. |
| WSOS-FLP-003 | Review/reset app permissions, remove app data | Missing | App Center "permissions" section is display-only; no reset/data removal operation. |
| WSOS-FLP-004 | Prune unused runtimes only when unused | Partial | Traceability claims it; no explicit `flatpak uninstall --unused` handling found in `service.ts`. |
| WSOS-AIM-001 | AppImage import to ~/.local/share/worksuite/appimages with metadata | Missing | Only mock entries in `AppCenter.tsx`. |
| WSOS-AIM-002 | First run approval; policy may forbid | Missing | Not implemented (policy field exists server-side only). |
| WSOS-AIM-003 | Verify embedded signatures; no fake verification | Missing | Not implemented. |
| WSOS-AIM-004 | AppImage updates only if authentic | Missing | Not implemented. |
| WSOS-LCH-001 | Launch via desktop-entry libraries / fixed argv | Partial | `gtk-launch` with validated id via `execFile` (`shell/electron/main.ts`); no test. |
| WSOS-LCH-002 | X11 apps via on-demand XWayland | Partial | Labwc default XWayland; `DISPLAY` imported in `worksuite-session`; no test. |
| WSOS-LCH-003 | Windows EXE shows explanation | Missing | No handler for .exe / application/x-ms-dos-executable. |

## 7 Integration and Drive

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| WSOS-INT-001 | Networking (NM, VPN, captive portal) | Partial | `network-manager` dependency; Settings › Network is static mock. |
| WSOS-INT-002 | Audio (PipeWire) | Partial | PipeWire deps; Settings › Sound UI not wired. |
| WSOS-INT-003 | Bluetooth (BlueZ), policy disable | Partial | `bluez` dep; policy `bluetooth: false` masks bluetooth.service and rfkill-blocks radios (`services/device-agent/src/host.ts`, mapping tested); Settings Bluetooth page is still a static mock. |
| WSOS-INT-004 | Storage (UDisks2), policy block removable | Partial | `udisks2` dep; policy `usb_storage` block (modprobe install /bin/false + UDISKS_IGNORE) / read_only (udev blockdev --setro) enforced by the device agent (mapping tested). No storage UI. |
| WSOS-INT-005 | Power (UPower/logind) | Partial | Suspend/restart/shutdown via `systemctl` (`main.ts`), `lib/power.ts` tested; battery/profiles static. |
| WSOS-INT-006 | Printing (CUPS) | Partial | `cups` dep; Settings › Printers static. |
| WSOS-INT-007 | Notifications server (org.freedesktop.Notifications) | Partial | In-shell notice centre with DND (`Desktop.tsx`, `lib/useNotices.ts`, `lib/syncNotices.test.ts`); shell does not own `org.freedesktop.Notifications`. |
| WSOS-INT-008 | Tray (SNI host) P2 | Missing | Only described in `native/panel/README.md`. |
| WSOS-INT-009 | Secret Service unlock/lock with session | Partial | `gnome-keyring` dep, lock on logout in `worksuite-session`, broker lock follows session lock (`shell/electron/broker.ts`, `broker.test.ts`); PAM unlock-on-login not configured. |
| WSOS-INT-010 | Shell-rendered polkit agent | Partial | `worksuite-polkit-agent.service` runs lxpolkit (or mate-polkit), a native GTK agent that shows the action, program and admin account; failures count toward pam_faillock. Not shell-rendered as the SRS asks; no test. |
| WSOS-INT-011 | Input methods (fcitx5, Sinhala/Tamil) | Partial | `fcitx5` dependency; no fcitx5 config, Sinhala/Tamil IMs (`fcitx5-m17n` etc.) not listed. |
| WSOS-INT-012 | Portals with explicit backend config | Partial | `services/session/portals/worksuite-portals.conf`; no per-interface acceptance test. |
| WSOS-INT-013 | Screen capture consent, indicator | Partial | ScreenCast/Screenshot → wlr backend configured; no consent dialog or persistent indicator. |
| WSOS-INT-014 | fwupd (P3) | Partial | `Recommends: fwupd` in `packaging/debian/control`; no qualification list. |
| WSOS-DRV-001 | Drive sync reuses Desktop sync engine/protocol | Partial | `services/sync` implements the api/sync protocol (tested); file transfer engine for Drive is not in the repo (per traceability). |
| WSOS-DRV-002 | Per-file sync states | Done | `services/sync/src/service.ts` (`fileStates`), `shell/src/screens/Files.tsx`, `shell/electron/files.ts`; tests `shell/electron/files.test.ts`, `services/sync/test/service.test.ts`. |
| WSOS-DRV-003 | Office takes server file lock | Partial | Server route `files/{id}/lock` tested (`services/server/test/api.test.ts`); no client/Office integration. |
| WSOS-DRV-004 | Conflict copy naming, no silent overwrite | Done | `services/sync/src/policy.ts` (`conflictCopyName`), tested in `services/sync/test/sync.test.ts`. |
| WSOS-DRV-005 | No FUSE in 1.0 (scope) | Done | None present (scope exclusion satisfied). |

## 8 Identity and sync

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| WSOS-IDN-001 | OIDC code + PKCE, no client secret | Done | `services/credentials/src/broker.ts`, `oidc.ts`, `pkce.ts`; `services/credentials/test/broker.test.ts`; server `services/server/src/oauth.ts` with E2E. |
| WSOS-IDN-002 | Refresh tokens only in Secret Service | Done | `services/credentials/src/keyring.ts` (secret-tool), tested with memory store in `broker.test.ts`. |
| WSOS-IDN-003 | Short-lived access tokens in memory | Done | Server 15-min tokens (`oauth.ts`), broker in-memory cache; tested. |
| WSOS-IDN-004 | Policy-required connectivity for first login/enrolment | Partial | Enterprise first-run requires enrolment (`shell/src/screens/FirstRun.tsx`) but "Skip setup" bypasses it; no policy flag. |
| WSOS-IDN-005 | Separate device credential as X-WS-Device | Done | `services/sync/src/transport.ts`, `services/device-agent/src/api.ts`, server checks in `api.ts`; tested in `services/server/test/api.test.ts`/`e2e.test.ts`. |
| WSOS-IDN-006 | DEVICE_REVOKED stops sync with notice | Done | `services/sync/src/engine.ts`, `shell/src/lib/syncNotices.ts`; tests `sync.test.ts`, `syncNotices.test.ts`. |
| WSOS-IDN-007 | Cloud revocation does not disable local account | Partial | Nothing disables local accounts (implicit); local retention/offline duration by policy not implemented. |
| WSOS-IDN-008 | One shared token broker for shell/apps/Office | Partial | Broker D-Bus API `services/user-service/dbus/lk.worksuite.Credentials1.xml`, used by shell (`shell/electron/broker.ts`); no WorkSuite app/Office consumer. |
| WSOS-SYN-001 | Server dedupes by (account, mutation_id) | Done | `services/server/src/api.ts`; client `sync.test.ts`, server `api.test.ts`/`e2e.test.ts`. |
| WSOS-SYN-002 | Ack + cursor advance in one transaction | Done | `services/sync/src/engine.ts`, `store.ts`; `sync.test.ts` crash-before-ack case. |
| WSOS-SYN-003 | Backoff 1 s → 5 min with jitter | Done | `services/sync/src/backoff.ts`; tested in `sync.test.ts`. |
| WSOS-SYN-004 | Validation/permission errors shown per record, not retried | Partial | `engine.ts`, `LocalStore.failed()` tested; no UI shows per-record errors. |
| WSOS-SYN-005 | One refresh on 401; never discard pending | Done | `engine.ts` (`authed`); "expired token → pending kept" test in `sync.test.ts`. |
| WSOS-SYN-006 | Expired cursor → bounded full resync | Done | `engine.ts` (`pull`, `sweep`), server 410 in `api.ts`; tested. |
| WSOS-SYN-007 | Tombstones kept for server window (30 d) | Done | `services/server/src/api.ts`, `services/sync/src/db.ts`; `api.test.ts`. |
| WSOS-SYN-008 | Sign-out with unsent changes: wait/export/discard | Done | `shell/src/screens/Settings.tsx` (`UnsentDialog`), `shell/electron/main.ts`, `services/sync/src/service.ts`; `service.test.ts`, `shell/electron/broker.test.ts`. |
| WSOS-SYN-009 | Apps declare/display offline level | Partial | `offline_level` in `api-contracts/openapi.yaml` and `services/server/src/admin.ts`; shell never displays it. |
| WSOS-SYN-010 | SQLite on encrypted storage when LUKS enabled | Partial | DB under the user's home, on LUKS when installed encrypted (`installer/modules/partition.conf`); no check or test. |

## 9 Updates, MDM, installer

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| WSOS-UPD-001 | Coordinator: metadata, disk, AC/battery ≥40%, locks, download, apply, reboot, health | Partial | `services/package-service/src/coordinator.ts`, `service.ts` preconditions; tested. No post-update health check / rollback step found. |
| WSOS-UPD-002 | Rings dev/pilot/stable from policy | Done | `coordinator.ts` ring from policy, server policy validation (`console.ts`); tested in `coordinator.test.ts`, `console.test.ts`. |
| WSOS-UPD-003 | Maintenance windows, deferral limits, mandatory updates | Done | `services/package-service/src/updates.ts` (`decide`, `canDefer`); `updates.test.ts`. |
| WSOS-UPD-004 | Release managers pause rollout / emergency release | Partial | Manifest `state: paused/pulled` honoured on device (`updates.ts`, tested); server has publish only (`services/server/src/admin.ts`), no pause/emergency workflow. |
| WSOS-UPD-005 | Report results with OS/shell/kernel versions | Done | `coordinator.ts` → `desktop/v1/os/update-results` (`services/server/src/api.ts`); tested. |
| WSOS-UPD-006 | Never delete user data/outbox/licences | Partial | Package ops never touch user data by design; no explicit test. |
| WSOS-MDM-001 | Agent reports hardware, software, versions, update status | Partial | `services/device-agent/src/host.ts` (`facts`, `inventory`); tested with fakes in `agent.test.ts`. Hardware inventory limited. |
| WSOS-MDM-002 | Policy covers allowlist, repos, ring, window, lock timeout, offline period, USB, Bluetooth | Done | All fields in the signed policy schema (`api-contracts/openapi.yaml`, `services/server/src/console.ts`, console form): allowlist, remotes, ring, window, `lock_timeout_max_s`, `offline_access_days`, `usb_storage`, `bluetooth`, plus `login_failures_max`/`login_lockout_s`. Device enforcement in `services/device-agent/src/enforce.ts` + `host.ts` `applyEnforcement` (lock-policy file, faillock.conf, modprobe/udev rules for USB block/read-only, bluetooth.service mask + rfkill), re-applied at start and lifted on unenroll; tested in `services/device-agent/test/agent.test.ts` and `services/server/test/console.test.ts`. Host effects (udevadm/rfkill) not run in CI. |
| WSOS-MDM-003 | Remote command allow-list | Done | `services/device-agent/src/commands.ts`; `commands.test.ts`. |
| WSOS-MDM-004 | Unique ID, expiry, signature, replay protection, ack | Done | `commands.ts`, `agent.ts`; `commands.test.ts`, `services/server/test/e2e.test.ts`. |
| WSOS-MDM-005 | Console shows requested vs observed state | Partial | `services/server/src/console.ts`/`console-ui.ts` show command ack states; requested-vs-observed policy state not separated. |
| WSOS-MDM-006 | No remote shell | Done | No such command in `commands.ts`; allow-list test rejects others. |
| WSOS-MDM-007 | About this device: managed, by whom, policies | Done | `agent.ts` (`status`) → `Settings.tsx` (`AboutDevice`); `shell/electron/device.test.ts`. |
| WSOS-INS-001 | Live desktop + Calamares installer | Partial | Live ISO boots in CI (`tests/vm/boot-test.sh`); installer config in `installer/`; installation never run in CI. |
| WSOS-INS-002 | Language, keyboard, timezone, first admin | Partial | `installer/settings.conf` (welcomeq/keyboardq/localeq/usersq); not tested. |
| WSOS-INS-003 | Disk model/size + typed confirmation | Done | `installer/modules/worksuiteconfirm/` with `Tests.cpp`; not run against a real disk. |
| WSOS-INS-004 | LUKS2 with recovery key shown once, plus unencrypted | Done | `partition.conf`, `installer/modules/worksuiterecovery/main.py` + `tests/test_main.py`, `worksuiteconfirm-recovery.conf`. |
| WSOS-INS-005 | Fully offline install | Partial | `packages.conf` only removes packages, `welcomeq.conf` no internet check; untested. |
| WSOS-INS-006 | Enroll with token or QR (MAY) | Partial | Enrollment code in first-run (`FirstRun.tsx`, `shell/electron/device.ts`, tested), not in the installer; no QR. |
| WSOS-INS-007 | Fresh machine-id, no live credentials copied | Partial | Hook empties `/etc/machine-id`; `installer/modules/machineid.conf`; untested. |
| WSOS-INS-008 | No dual boot/BIOS (scope) | Done | `partition.conf` erase-only, `allowManualPartitioning: false`, EFI only. |
| WSOS-INS-009 | First-boot assistant: network, mode, sign-in (skippable) | Partial | `shell/src/screens/FirstRun.tsx` (mode, sign-in, skip; `lib/setup.test.ts`); network step not wired to NetworkManager; not wired to first boot. |

## 11 Non-functional

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| WSOS-PRF-001 | Greeter ≤30 s | Missing | No measurement scripts. |
| WSOS-PRF-002 | Login → desktop ≤5 s | Missing | No measurement. |
| WSOS-PRF-003 | Idle memory ≤1.5 GiB | Missing | No measurement. |
| WSOS-PRF-004 | Idle CPU <2% | Missing | No measurement. |
| WSOS-PRF-005 | Launcher first frame ≤200 ms | Missing | No measurement. |
| WSOS-PRF-006 | Shell restart ≤3 s | Partial | RestartSec=1s configured; not measured. |
| WSOS-REL-001 | 100 login/logout cycles clean | Missing | No test. |
| WSOS-REL-002 | 50 suspend/resume cycles, lock intact | Partial | Lock before suspend wired (swayidle -w before-sleep → worksuite-lock, see LOCK-002); no 50-cycle suspend/resume test. |
| WSOS-REL-003 | No lost ack'd write / duplicate effect | Done | `services/sync/test/sync.test.ts` adversarial cases, `services/server/test/e2e.test.ts`. |
| WSOS-REL-004 | Killing Electron spares apps | Partial | Apps run in their own `app-worksuite-*.scope` (`shell/electron/session.ts`, unit-tested); no test that kills Electron in a running session. |
| WSOS-SEC-001 | Sandbox, context isolation, no Node, restricted navigation | Partial | `shell/electron/main.ts` webPreferences, will-navigate blocked; no navigation allow-list for server origins, no test. |
| WSOS-SEC-002 | Local bundle + restrictive CSP | Partial | CSP meta in `shell/index.html`; `style-src 'unsafe-inline'`; untested. |
| WSOS-SEC-003 | Web permissions denied by default, per origin grants | Partial | `setPermissionRequestHandler` denies all (`main.ts`); no per-origin grant mechanism. |
| WSOS-SEC-004 | Per-app session partitions | Missing | No WorkSuite business app windows/partitions. |
| WSOS-SEC-005 | Untrusted documents parsed outside privileged processes | Partial | Flatpak metadata parsed in root package service (`service.ts`); no explicit policy/test. |
| WSOS-SEC-006 | URL scheme allow-list | Partial | `ALLOWED_SCHEMES` in `main.ts`; untested. |
| WSOS-SEC-007 | Caller validation + systemd hardening | Partial | Caller UID/polkit in `dbus.ts` (tested); hardening in `services/*/systemd/*.service`; device agent caller checks untested. |
| WSOS-SEC-008 | Privileged changes audited locally and to server | Partial | Local audit (`service.ts`, `agent.ts` `audit`), server admin_log (`console.ts`); package changes not reported to server. |
| WSOS-SEC-009 | LUKS2 at install + AppArmor profiles for services | Partial | LUKS2 done (installer); `apparmor` is a dependency but no profiles ship. |
| WSOS-SEC-010 | No SSH server | Done | `Conflicts: openssh-server` (`packaging/debian/control`), build-time check in the live-build hook; image is built in CI. |
| WSOS-SEC-011 | Offline/HSM keys; SBOM per release | Partial | Public keyring only (`packaging/keyring/`, `tools/repo/keygen.sh`); no SBOM generation, HSM process undocumented. |
| WSOS-SEC-012 | Electron supported, patched in 14 days | Partial | Electron pinned in `shell/package.json`; no update policy/automation. |
| WSOS-SEC-013 | Docs don't claim isolation of unsandboxed apps | Partial | No contrary claim found; no explicit statement or review. |
| WSOS-SEC-014 | Secure Boot full chain + key strategy (P2) | Partial | `shim-signed`, `--uefi-secure-boot auto`; no documented key strategy or module signing. |
| WSOS-ACC-001…006 | Accessibility: keyboard, focus, Orca, high contrast, 200% text, reduced motion | Partial | ARIA labels and keyboard handling in shell screens (`Desktop.tsx`); no high-contrast theme, reduced-motion handling or Orca qualification. |

## 14 Additions (AUP, ARM, WIPE, DIR)

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| WSOS-AUP-001 | Check 15 min after boot and every 6 h, by ring/arch | Done | `services/package-service/src/main.ts`/`coordinator.ts`; `coordinator.test.ts`. |
| WSOS-AUP-002 | Signature verification of manifests and InRelease | Done | `updates.ts` (`verifyManifest`), `tests/repo/apt-e2e.sh` (tampered/foreign refused), `updates.test.ts`. |
| WSOS-AUP-003 | Refuse downgrades without signed rollback | Done | `updates.ts` `decide`; `updates.test.ts`. |
| WSOS-AUP-004 | Automatic/Notify/Manual modes; Manual personal-only | Done | `updates.ts`; `updates.test.ts`. |
| WSOS-AUP-005 | Security updates install except in Manual | Done | `updates.ts`; `updates.test.ts`. |
| WSOS-AUP-006 | Staged rollout bucket; pause/pull stops | Done | `updates.ts` (`rolloutBucket`); `updates.test.ts`. |
| WSOS-AUP-007 | ≤3 deferrals, deadline, 15-min warning | Done | `updates.ts` (`MAX_DEFERRALS`, `warn_restart`), `coordinator.ts`; tested. |
| WSOS-AUP-008 | Resumable downloads; pause on metered unless critical | Partial | Metered handling tested (`updates.ts`); no resumable download logic (apt handles partials implicitly, untested). |
| WSOS-AUP-009 | Policy mirror, signatures still verified | Done | `coordinator.ts` (`update_mirror`); tested in `coordinator.test.ts`. |
| WSOS-AUP-010 | Signed .wsupdate bundles from USB | Missing | Only mentioned in `services/package-service/README.md`. |
| WSOS-AUP-011 | Settings › Updates + panel badge; results reported | Partial | Settings › Updates (`Settings.tsx`, `shell/electron/packages.ts`, tested) and result reporting done; no panel badge (native panel missing). |
| WSOS-AUP-012 | Edition entitlement gating; security during grace | Missing | No licence/entitlement handling. |
| WSOS-AUP-013 | Update Center admin: publish, promote, pause, pull | Partial | Signed publish in `services/server/src/admin.ts`; no promote/pause/pull or `desktop.releases.manage` permission. |
| WSOS-ARM-001 | arm64 packages and ISO from same tag | Partial | `live-build/auto/config` accepts arm64, `packaging/debian/control` arch lists; CI builds amd64 only (`.github/workflows/image.yml`). |
| WSOS-ARM-002 | ARM via UEFI only | Partial | grub-efi for arm64 configured; never booted. |
| WSOS-ARM-003 | Certified ARM list with hardware gates | Missing | No list. |
| WSOS-ARM-004 | Native arm64 builds of Electron, panel, bridge, services, Office | Partial | Package architectures declared; panel/bridge/Office absent; no arm64 build. |
| WSOS-ARM-005 | App Center arch filtering, AppImage arch check | Missing | Not implemented. |
| WSOS-ARM-006 | No x86 emulation (scope) | Done | None shipped. |
| WSOS-ARM-007 | Separate ARM performance gates | Missing | No performance gates at all. |
| WSOS-ARM-008 | CI arm64 QEMU UEFI tests | Missing | `tests/vm/boot-test.sh` is x86_64 only. |
| WSOS-WIPE-001 | Permission, re-auth, typed name, second approver | Partial | Two-person rule plus admin re-authentication (password) and typed device-name confirmation on both request and approval (`services/server/src/console.ts` `reauth`, console UI keeps the button disabled until both are entered; failures audited and throttled); tested in `services/server/test/console.test.ts`. No separate `desktop.devices.wipe` permission (any admin) and no CoreApprovalEngine. |
| WSOS-WIPE-002 | Data wipe removes tokens, DB, Drive, caches for all users | Done | `services/device-agent/src/host.ts` (`wipeWorkSuiteData`), `agent.ts`; `agent.test.ts` (with fake host). |
| WSOS-WIPE-003 | Full wipe destroys LUKS slots, refused on unencrypted | Done | `host.ts` (`cryptoErase`), `agent.ts` NOT_ENCRYPTED; `agent.test.ts`. Not exercised on a real LUKS device. |
| WSOS-WIPE-004 | Signed, device-bound, single-use, 30-day expiry | Done | `commands.ts`, server issues with 30×24 h (`console.ts`); `commands.test.ts`. |
| WSOS-WIPE-005 | Ack started before destroying; console state progression | Done | `agent.ts` (`wipe`); `agent.test.ts`, console states in `console.ts`. |
| WSOS-WIPE-006 | Offline kill timer | Done | `agent.ts` (`offlineKillTimer`); `agent.test.ts`. |
| WSOS-WIPE-007 | User sees wipe capability in About this device | Done | `Settings.tsx` (`AboutDevice`); `shell/electron/device.test.ts`. |
| WSOS-WIPE-008 | Server audits; wiped devices marked and need re-enrolment | Partial | Requests/approvals audited (`console.ts` admin_log); device-side "wiped" state, but server-side "Wiped" device marking not evident. |
| WSOS-DIR-001 | Directory join (installer, Settings, policy) | Missing | No directory join code. |
| WSOS-DIR-002 | Greeter "Other user" with domain formats | Partial | `shell/src/screens/Greeter.tsx` has "Other user" UI and account-name validation (`components/AAccount.ts`); not the shipped greeter, no domain backend. |
| WSOS-DIR-003 | Home dirs with stable UID/GID | Missing | No sssd/pam_mkhomedir/idmap config. |
| WSOS-DIR-004 | Cached offline directory login | Missing | Not implemented. |
| WSOS-DIR-005 | Disabled accounts refused; cache expiry | Partial | Offline period expiry ends local sign-in (pam_nologin file from the device agent, see AUTH-003); no directory accounts, so "disabled account refused at next online login" is not implemented. |
| WSOS-DIR-006 | Group → local role mapping | Missing | Not implemented. |
| WSOS-DIR-007 | Password expiry at greeter | Missing | Not implemented. |
| WSOS-DIR-008 | SSO token after directory login | Missing | Not implemented. |
| WSOS-DIR-009 | pam_worksuite with TLS/device binding/MFA | Missing | No pam_worksuite module. |
| WSOS-DIR-010 | Escrowed rotating break-glass admin | Missing | Not implemented. |
| WSOS-DIR-011 | Smart-card login (P3) | Missing | Not implemented. |

## Unnumbered requirements (no WSOS ID)

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| §9.2-R1 | Interrupted package op: boot-time detection + audited Repair | Partial | Same as WSOS-APT-006: `service.ts` (tested), no boot-time unit or UI. |
| §9.2-R2 | Broken shell → recovery launcher | Partial | See WSOS-SES-005. |
| §9.2-R3 | Boot menu "WorkSuite Recovery" text-UI target | Missing | `dialog` in package list; no GRUB entry or recovery target. (Recovery designs only in `docs/design/boot-install/`.) |
| §9.2-R4 | Previous kernel entry for failed kernel/graphics update | Missing | See WSOS-BOOT-003. |
| §9.2-R5 | Local DB corruption: integrity check, export outbox, rebuild | Done | `services/sync/src/main.ts` (`checkIntegrity`); covered in `services/sync/test/service.test.ts`. |
| §9.2-R6 | Reinstall keeping /home (P2) | Missing | Installer is erase-only. |
| §9.3 enrolment flow | Short-lived token, device key pair (TPM when available), signed policy, heartbeat | Done | `services/device-agent/src/agent.ts` (`enroll`, `refreshPolicy`), server `api.ts`; `agent.test.ts`, `services/server/test/e2e.test.ts`. |
| §7.1 portal acceptance | Test each portal interface used | Missing | No portal tests. |
| §7.1 Meet screencast | ScreenCast portal path, consent + emergency stop | Missing | Not implemented. |
| §11.5 Localisation | Externalised strings; Sinhala/Tamil input in 1.0; locale formats | Partial | Noto fonts and fcitx5 dependency; UI strings hard-coded English; no i18n framework. |
| §11.6-a | One Debian package per component + metapackage | Done | `packaging/debian/control`, `packaging/build-debs.sh`; built in `image.yml`. |
| §11.6-b | Defaults in /usr/share,/etc; user state in XDG dirs | Partial | Followed in services; untested. |
| §11.6-c | Structured JSON logs with request IDs | Partial | Request IDs in transports and server (`services/server/src/http.ts`, `services/sync/src/transport.ts`); not uniform JSON to journald. |
| §11.6-d | "Report a problem" diagnostic bundle reviewed before upload | Partial | Button in `shell/src/screens/Recovery.tsx`; `CollectApprovedDiagnostics` command; no bundle builder or review UI. |
| §13.1 adversarial | Duplicate mutation, crash-before-ack, offline edits, expired token, malicious IPC, replay | Partial | All covered in `services/sync/test/sync.test.ts` and `services/device-agent/test/commands.test.ts` except malicious IPC. |
